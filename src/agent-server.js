const http = require('http');
const crypto = require('crypto');
const AIToolkit = require('./index');

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function defineAgent(options) {
  if (!options || !AGENT_ID.test(options.id || ''))
    throw new Error('Agent id must be a stable lowercase slug');
  if (!['stateless', 'stateful'].includes(options.mode))
    throw new Error('Agent mode must be stateless or stateful');
  if (options.tools && !Array.isArray(options.tools))
    throw new Error('Agent tools must be an array');
  if (options.callOptions?.guard !== undefined && typeof options.callOptions.guard !== 'function')
    throw new Error('Agent decision guard must be a function');
  if (
    options.callOptions?.guardTimeoutMs !== undefined &&
    (!Number.isInteger(options.callOptions.guardTimeoutMs) ||
      options.callOptions.guardTimeoutMs < 1 ||
      options.callOptions.guardTimeoutMs > 120000)
  )
    throw new Error('Agent guardTimeoutMs must be between 1 and 120000 milliseconds');
  return Object.freeze({ ...options, tools: options.tools ? [...options.tools] : [] });
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

function publicResult(result) {
  if (result?.errorCode === 'guard_rejected') return { success: false, error: 'decision_rejected' };
  return result?.success === false ? { success: false, error: 'agent_failed' } : result;
}

async function readBody(req, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw Object.assign(new Error(), { status: 415, code: 'json_required' });
  if (Number(req.headers['content-length']) > maxBytes)
    throw Object.assign(new Error(), { status: 413, code: 'body_too_large' });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(), { status: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error(), { status: 400, code: 'invalid_json' });
  }
}

function requestInstance(base, state) {
  const ai = Object.create(base);
  ai.context = new Map();
  ai.untrustedContext = state?.context || null;
  ai.messages = state?.messages ? structuredClone(state.messages) : [];
  ai.lastResult = null;
  return ai;
}

async function runOperation(def, base, input, state, runId, principal, sessionId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { invalid: true };
  const ai = requestInstance(base, state);
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
        try {
          return await def.onToolCall(...args);
        } catch {
          return { error: 'tool_error' };
        }
      })
  };
  const options = { ...modelOptions };
  let result;
  return base.runContext.run({ runId, principal, agentId: def.id, sessionId }, async () => {
    if (operation === 'chat') {
      if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 8000)
        return { invalid: true };
      result = await ai.chat(data.prompt, { ...chatOptions, trackHistory: !!state });
    } else if (operation === 'decide') {
      if (!Array.isArray(data.actions) || data.actions.length < 1 || data.actions.length > 30)
        return { invalid: true };
      result = await ai.decide(data.context, data.actions, {
        ...options,
        guard,
        guardTimeoutMs
      });
    } else if (operation === 'extract') {
      if (typeof data.schema !== 'string' || !Object.hasOwn(def.schemas || {}, data.schema))
        return { invalid: true };
      result = await ai.extract(data.data, def.schemas[data.schema], options);
    } else if (operation === 'summarize') {
      result = await ai.summarize(data.content, options);
    } else if (operation === 'validate') {
      if (typeof data.criteria !== 'string') return { invalid: true };
      result = await ai.validate(data.criteria, data.subject, data.reference || null, options);
    } else return { invalid: true };
    return {
      result,
      state: state
        ? {
            messages: ai.messages
              .slice(-(def.maxHistoryMessages || 50))
              .filter((_, i, all) => i || all[0].role !== 'assistant'),
            context: state.context
          }
        : null
    };
  });
}

function serveAgents(options = {}) {
  const apiKey = options.apiKey || process.env.NULLPROTOCOL_API_KEY;
  if (!apiKey && !options.authenticate)
    throw new Error('An API key or authenticate hook is required');
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
    if (def.mode === 'stateful' && !options.store)
      throw new Error(`Stateful agent ${def.id} requires a session store`);
    const { id, mode, tools, onToolCall, callOptions, maxHistoryMessages, ...modelOptions } = def;
    const base = new AIToolkit({ ...modelOptions, agentId: id, trackHistory: false });
    selected.set(id, { def, base, disabled: false, active: 0 });
  }
  if (!selected.size) throw new Error('No agents selected');
  const maxConcurrent = options.maxConcurrentTurns || 32;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error('maxConcurrentTurns must be positive');
  const maxBody = options.maxBodyBytes || 65536;
  const store = options.store;
  let active = 0;
  const cleanup =
    store?.purgeExpired && setInterval(() => store.purgeExpired().catch(() => {}), 3600000);
  cleanup?.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz')
        return respond(res, 200, { status: 'ok' });
      if (req.method === 'GET' && pathname === '/readyz') {
        const ready = selected.size && [...selected.values()].some(a => !a.disabled);
        return respond(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
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
      if (!principal || typeof principal !== 'string' || principal.length > 128)
        return failure(res, 401, 'unauthorized');
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
      if (options.authenticate && identity?.agents && !identity.agents.includes(def.id))
        return failure(res, 403, 'forbidden');
      const rest = m[2] || '';
      if (['disable', 'enable'].includes(rest) && options.authenticate && !identity?.canManage)
        return failure(res, 403, 'forbidden');
      if (req.method === 'POST' && rest === 'disable') {
        agent.disabled = true;
        return respond(res, 200, { disabled: true, activeRuns: agent.active });
      }
      if (req.method === 'POST' && rest === 'enable') {
        agent.disabled = false;
        return respond(res, 200, { disabled: false });
      }
      if (agent.disabled) return failure(res, 409, 'agent_disabled');
      if (req.method === 'POST' && rest === 'invoke' && def.mode === 'stateless') {
        if (active >= maxConcurrent) return failure(res, 503, 'overloaded');
        active++;
        agent.active++;
        try {
          const input = await readBody(req, maxBody);
          const runId = crypto.randomUUID();
          const outcome = await runOperation(def, base, input, undefined, runId, principal);
          if (outcome.invalid) return failure(res, 400, 'invalid_input');
          return respond(
            res,
            outcome.result?.errorCode === 'guard_rejected'
              ? 422
              : outcome.result?.success === false
                ? 502
                : 200,
            {
              runId,
              output: publicResult(outcome.result)
            }
          );
        } finally {
          active--;
          agent.active--;
        }
      }
      if (req.method === 'POST' && rest === 'sessions' && def.mode === 'stateful') {
        const body = await readBody(req, maxBody);
        const context = body?.context || {};
        if (
          typeof context !== 'object' ||
          Array.isArray(context) ||
          Buffer.byteLength(JSON.stringify(context)) > 16384
        )
          return failure(res, 400, 'invalid_context');
        const sessionId = await store.create(
          { agent: def.id, principal },
          { messages: [], context }
        );
        return respond(res, 201, { sessionId });
      }
      const s = rest.match(/^sessions\/([0-9a-f-]{36})(?:\/(messages|context|history))?$/);
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
        if (active >= maxConcurrent) return failure(res, 503, 'overloaded');
        active++;
        agent.active++;
        let acquired;
        let heartbeat;
        try {
          const input = await readBody(req, maxBody);
          if (
            typeof input?.prompt !== 'string' ||
            !input.prompt.trim() ||
            input.prompt.length > 8000
          )
            return failure(res, 400, 'invalid_input');
          const leaseMs = 60000;
          acquired = await store.acquire(ref, leaseMs);
          if (acquired.status !== 'acquired')
            return failure(
              res,
              acquired.status === 'busy' ? 409 : 404,
              acquired.status === 'busy' ? 'session_busy' : 'not_found'
            );
          let leaseLost = false;
          heartbeat = setInterval(async () => {
            try {
              if (!(await store.renew(ref, acquired.lease, leaseMs))) leaseLost = true;
            } catch {
              leaseLost = true;
            }
          }, 10000);
          heartbeat.unref();
          const runId = crypto.randomUUID();
          const outcome = await runOperation(
            def,
            base,
            { operation: 'chat', input: { prompt: input.prompt } },
            acquired.state,
            runId,
            principal,
            ref.id
          );
          clearInterval(heartbeat);
          heartbeat = null;
          if (outcome.result?.success === false) {
            await store.release(ref, acquired.lease);
            return respond(res, 502, { output: publicResult(outcome.result) });
          }
          if (leaseLost) {
            await store.release(ref, acquired.lease);
            return failure(res, 409, 'lease_lost');
          }
          if (!(await store.commit(ref, acquired.lease, outcome.state)))
            return failure(res, 409, 'lease_lost');
          return respond(res, 200, { runId, output: publicResult(outcome.result) });
        } catch (error) {
          if (acquired?.lease) await store.release(ref, acquired.lease);
          throw error;
        } finally {
          clearInterval(heartbeat);
          active--;
          agent.active--;
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
  server.agents = selected;
  server.once('close', () => clearInterval(cleanup));
  server.shutdown = async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    await closed;
    await Promise.all([...selected.values()].map(({ base }) => base.telemetry?.destroy()));
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
