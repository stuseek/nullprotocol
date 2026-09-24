const http = require('http');
const crypto = require('crypto');
const AIToolkit = require('./index');

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_PATH = new RegExp(
  `^sessions/(${UUID_PATH})(?:/(messages|context|history|cancel))?$`,
  'i'
);
const OPERATIONS = ['chat', 'decide', 'extract', 'summarize', 'validate'];
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNPAIRED_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function defineAgent(options) {
  if (!options || !AGENT_ID.test(options.id || '')) {
    throw new Error('Agent id must be a stable lowercase slug');
  }
  if (!['stateless', 'stateful'].includes(options.mode)) {
    throw new Error('Agent mode must be stateless or stateful');
  }
  if (options.tools && !Array.isArray(options.tools)) {
    throw new Error('Agent tools must be an array');
  }
  if (
    options.operations !== undefined &&
    (!Array.isArray(options.operations) ||
      !options.operations.length ||
      options.operations.some(operation => !OPERATIONS.includes(operation)) ||
      new Set(options.operations).size !== options.operations.length)
  ) {
    throw new Error('Agent operations must be a nonempty list of supported operations');
  }
  if (options.mode === 'stateful' && options.operations && !options.operations.includes('chat')) {
    throw new Error('Stateful agents must allow chat');
  }
  if (options.exposeToolCalls !== undefined && typeof options.exposeToolCalls !== 'boolean') {
    throw new Error('exposeToolCalls must be a boolean');
  }
  if (
    options.maxHistoryMessages !== undefined &&
    (!Number.isInteger(options.maxHistoryMessages) ||
      options.maxHistoryMessages < 1 ||
      options.maxHistoryMessages > 1000)
  ) {
    throw new Error('maxHistoryMessages must be between 1 and 1000');
  }
  if (
    options.maxHistoryTokens !== undefined &&
    (!Number.isInteger(options.maxHistoryTokens) ||
      options.maxHistoryTokens < 1 ||
      options.maxHistoryTokens > 50000)
  ) {
    throw new Error('maxHistoryTokens must be between 1 and 50000');
  }
  if (options.callOptions?.guard !== undefined && typeof options.callOptions.guard !== 'function') {
    throw new Error('Agent decision guard must be a function');
  }
  if (
    options.callOptions?.guardTimeoutMs !== undefined &&
    (!Number.isInteger(options.callOptions.guardTimeoutMs) ||
      options.callOptions.guardTimeoutMs < 1 ||
      options.callOptions.guardTimeoutMs > 120000)
  ) {
    throw new Error('Agent guardTimeoutMs must be between 1 and 120000 milliseconds');
  }
  return Object.freeze({
    ...options,
    tools: options.tools ? [...options.tools] : [],
    operations: Object.freeze(options.operations ? [...options.operations] : [...OPERATIONS])
  });
}

function constantTimeEqual(a, b) {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function respond(res, status, data, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra
  });
  res.end(JSON.stringify(data));
}

function failure(res, status, code) {
  respond(res, status, { error: { code } });
}

function shuttingDown(res) {
  res.setHeader('Connection', 'close');
  return failure(res, 503, 'shutting_down');
}

function publicResult(result, exposeToolCalls = false) {
  if (result?.errorCode === 'guard_rejected') return { success: false, error: 'decision_rejected' };
  if (result?.success === false) return { success: false, error: 'agent_failed' };
  if (!exposeToolCalls && result?.toolCalls) {
    const { toolCalls: _toolCalls, ...publicFields } = result;
    return publicFields;
  }
  return result;
}

async function readBody(req, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error(), { status: 415, code: 'json_required' });
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    throw Object.assign(new Error(), { status: 413, code: 'body_too_large' });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(), { status: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error(), { status: 400, code: 'invalid_json' });
  }
  const values = [body];
  while (values.length) {
    const value = values.pop();
    if (typeof value === 'string' && (value.includes('\0') || UNPAIRED_SURROGATE.test(value))) {
      throw Object.assign(new Error(), { status: 400, code: 'invalid_input' });
    }
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) for (const item of value) values.push(item);
      else for (const [key, item] of Object.entries(value)) values.push(key, item);
    }
  }
  return body;
}

function requestInstance(base, state) {
  const ai = Object.create(base);
  ai.context = new Map();
  ai.untrustedContext = state?.context || null;
  ai.messages = state?.messages ? structuredClone(state.messages) : [];
  ai.lastResult = null;
  return ai;
}

function cancelRun(run, code = 'run_cancelled') {
  if (run.phase !== 'running' || run.controller.signal.aborted) return false;
  run.controller.abort(Object.assign(new Error('Run cancelled'), { name: 'AbortError', code }));
  return true;
}

function cancelledResponse(res, run) {
  return respond(res, 409, {
    error: { code: run.controller.signal.reason?.code || 'run_cancelled' },
    runId: run.runId,
    toolCallsStarted: run.toolCallsStarted,
    toolCallIds: run.toolCallIds
  });
}

async function runOperation(def, base, input, state, run, principal, sessionId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { invalid: true };
  const ai = requestInstance(base, state);
  const signal = run.controller.signal;
  signal.throwIfAborted();
  const operation = input.operation || 'chat';
  const data = input.input || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { invalid: true };
  const { guard, guardTimeoutMs, ...modelOptions } = def.callOptions || {};
  const chatOptions = {
    ...modelOptions,
    tools: def.tools,
    onToolCall:
      def.onToolCall &&
      (async (...args) => {
        signal.throwIfAborted();
        run.toolCallsStarted++;
        if (args[2]?.callId) run.toolCallIds.push(args[2].callId);
        try {
          return await def.onToolCall(...args);
        } catch {
          if (signal.aborted) signal.throwIfAborted();
          return { error: 'tool_error' };
        }
      })
  };
  const options = { ...modelOptions };
  let result;
  return ai._runWithTrace(
    operation,
    run.runId,
    async () => {
      if (operation === 'chat') {
        if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 8000) {
          return { invalid: true };
        }
        result = await ai.chat(data.prompt, { ...chatOptions, trackHistory: !!state });
      } else if (operation === 'decide') {
        if (!Array.isArray(data.actions) || data.actions.length < 1 || data.actions.length > 30) {
          return { invalid: true };
        }
        result = await ai.decide(data.context, data.actions, {
          ...options,
          guard,
          guardTimeoutMs
        });
      } else if (operation === 'extract') {
        if (typeof data.schema !== 'string' || !Object.hasOwn(def.schemas || {}, data.schema)) {
          return { invalid: true };
        }
        result = await ai.extract(data.data, def.schemas[data.schema], options);
      } else if (operation === 'summarize') {
        result = await ai.summarize(data.content, options);
      } else if (operation === 'validate') {
        if (typeof data.criteria !== 'string') return { invalid: true };
        result = await ai.validate(data.criteria, data.subject, data.reference || null, options);
      } else return { invalid: true };
      signal.throwIfAborted();
      return {
        result,
        state: state
          ? {
              messages: ai.messages
                .slice(-(def.maxHistoryMessages ?? 50))
                .filter((_, i, all) => i || all[0].role !== 'assistant')
                .map(message => ({
                  ...message,
                  content: message.content
                    .replaceAll('\0', '')
                    .replace(UNPAIRED_SURROGATES, '\uFFFD')
                })),
              context: state.context
            }
          : null
      };
    },
    { principal, agentId: def.id, sessionId, signal }
  );
}

function serveAgents(options = {}) {
  const apiKey = options.apiKey || process.env.NULLPROTOCOL_API_KEY;
  if (!apiKey && !options.authenticate) {
    throw new Error('An API key or authenticate hook is required');
  }
  const definitions = Array.isArray(options.agents)
    ? options.agents
    : Object.entries(options.agents || {}).map(([id, config]) => ({ ...config, id }));
  const only =
    options.only ||
    (process.env.NP_AGENTS ? process.env.NP_AGENTS.split(',').map(s => s.trim()) : null);
  const selected = new Map();
  for (const input of definitions) {
    const def = defineAgent(input);
    if (only && !only.includes(def.id)) continue;
    if (selected.has(def.id)) throw new Error(`Duplicate agent: ${def.id}`);
    if (def.mode === 'stateful' && !options.store) {
      throw new Error(`Stateful agent ${def.id} requires a session store`);
    }
    const {
      id,
      mode,
      tools,
      onToolCall,
      callOptions,
      maxHistoryMessages,
      operations,
      exposeToolCalls,
      ...modelOptions
    } = def;
    const base = new AIToolkit({
      ...modelOptions,
      maxHistoryTokens: def.maxHistoryTokens ?? 8192,
      agentId: id,
      trackHistory: false
    });
    selected.set(id, { def, base, disabled: false, active: 0 });
  }
  if (!selected.size) throw new Error('No agents selected');
  const maxConcurrent = options.maxConcurrentTurns ?? 32;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrentTurns must be positive');
  }
  const maxBody = options.maxBodyBytes ?? 65536;
  if (!Number.isSafeInteger(maxBody) || maxBody < 1) {
    throw new Error('maxBodyBytes must be a positive integer');
  }
  const maxConnections = options.maxConnections ?? 256;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('maxConnections must be positive');
  }
  const store = options.store;
  let active = 0;
  let draining = false;
  const runs = new Map();
  const startRun = (agentId, principal, sessionId, res) => {
    const run = {
      runId: crypto.randomUUID(),
      agentId,
      principal,
      sessionId,
      controller: new AbortController(),
      phase: 'running',
      toolCallsStarted: 0,
      toolCallIds: []
    };
    const onClose = () => {
      if (!res.writableEnded) cancelRun(run, 'client_disconnected');
    };
    res.once('close', onClose);
    if (res.destroyed) onClose();
    run.done = new Promise(resolve => {
      run.finish = () => {
        res.off('close', onClose);
        resolve();
      };
    });
    runs.set(run.runId, run);
    return run;
  };
  const cleanup =
    store?.purgeExpired && setInterval(() => store.purgeExpired().catch(() => {}), 3600000);
  cleanup?.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        return respond(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && pathname === '/readyz') {
        return draining ? shuttingDown(res) : respond(res, 200, { status: 'ready' });
      }
      if (draining) {
        return shuttingDown(res);
      }
      const header = req.headers.authorization;
      const token =
        typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
      let principal;
      let identity;
      if (options.authenticate) {
        identity = await options.authenticate(req);
        principal = identity?.principal;
      } else if (token && constantTimeEqual(token, apiKey)) principal = 'service-key';
      if (draining) {
        return shuttingDown(res);
      }
      if (
        !principal ||
        typeof principal !== 'string' ||
        principal.length > 128 ||
        principal.includes('\0') ||
        UNPAIRED_SURROGATE.test(principal)
      ) {
        return failure(res, 401, 'unauthorized');
      }
      if (identity?.agents !== undefined && !Array.isArray(identity.agents)) {
        return failure(res, 403, 'forbidden');
      }
      if (req.method === 'GET' && pathname === '/v1/agents') {
        return respond(res, 200, {
          agents: [...selected]
            .filter(([id]) => !identity?.agents || identity.agents.includes(id))
            .map(([id, a]) => ({
              id,
              mode: a.def.mode,
              description: a.def.description || '',
              disabled: a.disabled
            }))
        });
      }
      const m = pathname.match(/^\/v1\/agents\/([a-z0-9][a-z0-9._-]{0,63})(?:\/(.*))?$/);
      if (!m || !selected.has(m[1])) return failure(res, 404, 'not_found');
      const { def, base } = selected.get(m[1]);
      const agent = selected.get(m[1]);
      if (options.authenticate && identity?.agents && !identity.agents.includes(def.id)) {
        return failure(res, 403, 'forbidden');
      }
      const rest = m[2] || '';
      if (
        ['disable', 'enable', 'stop'].includes(rest) &&
        options.authenticate &&
        identity?.canManage !== true
      ) {
        return failure(res, 403, 'forbidden');
      }
      if (req.method === 'POST' && rest === 'disable') {
        agent.disabled = true;
        return respond(res, 200, { disabled: true, activeRuns: agent.active });
      }
      if (req.method === 'POST' && rest === 'enable') {
        agent.disabled = false;
        return respond(res, 200, { disabled: false });
      }
      if (req.method === 'POST' && rest === 'stop') {
        agent.disabled = true;
        let cancelling = 0;
        for (const run of runs.values()) {
          if (run.agentId === def.id && cancelRun(run)) cancelling++;
        }
        return respond(res, 202, { disabled: true, cancelling, scope: 'process' });
      }
      const s = rest.match(SESSION_PATH);
      if (req.method === 'POST' && s?.[2] === 'cancel' && def.mode === 'stateful') {
        const run = [...runs.values()].find(
          current =>
            current.agentId === def.id &&
            current.sessionId === s[1] &&
            current.principal === principal
        );
        if (!run) return failure(res, 409, 'no_active_run');
        if (run.phase !== 'running') return failure(res, 409, 'run_committing');
        return respond(res, 202, { cancelling: cancelRun(run), runId: run.runId });
      }
      if (agent.disabled) return failure(res, 409, 'agent_disabled');
      if (req.method === 'POST' && rest === 'invoke' && def.mode === 'stateless') {
        const input = await readBody(req, maxBody);
        if (draining) return shuttingDown(res);
        if (res.destroyed) return;
        const operation = input?.operation || 'chat';
        if (!def.operations.includes(operation)) return failure(res, 403, 'operation_forbidden');
        if (agent.disabled) return failure(res, 409, 'agent_disabled');
        if (active >= maxConcurrent) return failure(res, 503, 'overloaded');
        active++;
        agent.active++;
        const run = startRun(def.id, principal, undefined, res);
        try {
          const outcome = await runOperation(def, base, input, undefined, run, principal);
          if (run.controller.signal.aborted) return cancelledResponse(res, run);
          if (outcome.invalid) return failure(res, 400, 'invalid_input');
          run.phase = 'responding';
          return respond(
            res,
            outcome.result?.errorCode === 'guard_rejected'
              ? 422
              : outcome.result?.success === false
                ? 502
                : 200,
            {
              runId: run.runId,
              output: publicResult(outcome.result, def.exposeToolCalls)
            }
          );
        } catch (error) {
          if (run.controller.signal.aborted) return cancelledResponse(res, run);
          throw error;
        } finally {
          runs.delete(run.runId);
          active--;
          agent.active--;
          run.finish();
        }
      }
      if (req.method === 'POST' && rest === 'sessions' && def.mode === 'stateful') {
        const body = await readBody(req, maxBody);
        if (draining) return shuttingDown(res);
        const context = body?.context || {};
        if (
          typeof context !== 'object' ||
          Array.isArray(context) ||
          Buffer.byteLength(JSON.stringify(context)) > 16384
        ) {
          return failure(res, 400, 'invalid_context');
        }
        const sessionId = await store.create(
          { agent: def.id, principal },
          { messages: [], context }
        );
        return respond(res, 201, { sessionId });
      }
      if (def.mode !== 'stateful' || !s) return failure(res, 404, 'not_found');
      const ref = { id: s[1], agent: def.id, principal };
      if (req.method === 'DELETE' && !s[2]) {
        const status = await store.delete(ref);
        return status === 'deleted'
          ? respond(res, 200, { deleted: true })
          : failure(
              res,
              status === 'busy' ? 409 : 404,
              status === 'busy' ? 'session_busy' : 'not_found'
            );
      }
      if (req.method === 'DELETE' && ['context', 'history'].includes(s[2])) {
        const status = await store.clear(ref, s[2]);
        return status === 'cleared'
          ? respond(res, 200, { cleared: s[2] })
          : failure(
              res,
              status === 'busy' ? 409 : 404,
              status === 'busy' ? 'session_busy' : 'not_found'
            );
      }
      if (req.method === 'POST' && s[2] === 'messages') {
        const input = await readBody(req, maxBody);
        if (draining) return shuttingDown(res);
        if (
          typeof input?.prompt !== 'string' ||
          !input.prompt.trim() ||
          input.prompt.length > 8000
        ) {
          return failure(res, 400, 'invalid_input');
        }
        if (agent.disabled) return failure(res, 409, 'agent_disabled');
        if (active >= maxConcurrent) return failure(res, 503, 'overloaded');
        active++;
        agent.active++;
        let acquired;
        let heartbeat;
        let run;
        try {
          const leaseMs = 60000;
          acquired = await store.acquire(ref, leaseMs);
          if (acquired.status !== 'acquired') {
            return failure(
              res,
              acquired.status === 'busy' ? 409 : 404,
              acquired.status === 'busy' ? 'session_busy' : 'not_found'
            );
          }
          if (draining || agent.disabled) {
            await store.release(ref, acquired.lease);
            return draining ? shuttingDown(res) : failure(res, 409, 'agent_disabled');
          }
          if (res.destroyed) {
            await store.release(ref, acquired.lease);
            return;
          }
          run = startRun(def.id, principal, ref.id, res);
          let renewPromise = null;
          heartbeat = setInterval(() => {
            if (renewPromise) return;
            renewPromise = Promise.resolve()
              .then(() => store.renew(ref, acquired.lease, leaseMs))
              .then(renewed => {
                if (!renewed) cancelRun(run, 'lease_lost');
              })
              .catch(() => {
                console.warn('nullprotocol: session lease renewal failed');
                cancelRun(run, 'lease_lost');
              })
              .finally(() => {
                renewPromise = null;
              });
          }, 10000);
          heartbeat.unref();
          const outcome = await runOperation(
            def,
            base,
            { operation: 'chat', input: { prompt: input.prompt } },
            acquired.state,
            run,
            principal,
            ref.id
          );
          clearInterval(heartbeat);
          heartbeat = null;
          if (renewPromise) await renewPromise;
          if (run.controller.signal.aborted) {
            try {
              await store.release(ref, acquired.lease);
            } catch {
              console.warn('nullprotocol: cancelled session lease release failed');
            }
            return cancelledResponse(res, run);
          }
          if (outcome.result?.success === false) {
            await store.release(ref, acquired.lease);
            return respond(res, 502, { output: publicResult(outcome.result, def.exposeToolCalls) });
          }
          run.phase = 'committing';
          if (!(await store.commit(ref, acquired.lease, outcome.state))) {
            return failure(res, 409, 'lease_lost');
          }
          run.phase = 'responding';
          return respond(res, 200, {
            runId: run.runId,
            output: publicResult(outcome.result, def.exposeToolCalls)
          });
        } catch (error) {
          if (acquired?.lease) {
            try {
              await store.release(ref, acquired.lease);
            } catch {
              console.warn('nullprotocol: session lease release failed');
            }
          }
          if (run?.controller.signal.aborted) return cancelledResponse(res, run);
          throw error;
        } finally {
          clearInterval(heartbeat);
          if (run) runs.delete(run.runId);
          active--;
          agent.active--;
          run?.finish();
        }
      }
      return failure(res, 404, 'not_found');
    } catch (error) {
      return failure(
        res,
        error.status || (error.code === 'ERR_INVALID_URL' ? 400 : 500),
        error.status
          ? error.code
          : error.code === 'ERR_INVALID_URL'
            ? 'invalid_url'
            : 'internal_error'
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = maxConnections;
  server.agents = selected;
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.once('close', () => clearInterval(cleanup));
  let shutdownPromise;
  const settledWithin = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), ms);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  server.shutdown = ({ drainTimeoutMs = 10000, cancelTimeoutMs = 2000 } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    if (
      !Number.isInteger(drainTimeoutMs) ||
      drainTimeoutMs < 0 ||
      !Number.isInteger(cancelTimeoutMs) ||
      cancelTimeoutMs < 0
    ) {
      return Promise.reject(new Error('Shutdown timeouts must be nonnegative integers'));
    }
    draining = true;
    shutdownPromise = (async () => {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections?.();
      const graceful = await settledWithin(closed, drainTimeoutMs);
      if (!graceful) {
        const unfinished = [...runs.values()].map(run => run.done);
        for (const run of runs.values()) cancelRun(run, 'shutdown');
        await settledWithin(Promise.allSettled(unfinished), cancelTimeoutMs);
        for (const socket of sockets) socket.destroy();
        await settledWithin(closed, 1000);
      }
      await Promise.all([...selected.values()].map(({ base }) => base.telemetry?.destroy()));
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    server.shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  if (options.handleSignals !== false) {
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    server.once('close', () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    });
  }
  server.listen(
    options.port ?? Number(process.env.PORT || process.env.NULLPROTOCOL_PORT || 3000),
    options.host || process.env.NULLPROTOCOL_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
  );
  return server;
}

module.exports = { defineAgent, serveAgents };
