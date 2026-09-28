const { randomUUID } = require('crypto');
const { PlatformTransport, PlatformError } = require('./managed-http');
const { runTextTurn, ManagedModelError } = require('./managed-model');
const { hashJson } = require('./managed-canonical');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPACE_KEY = /^np_space_[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_REF = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function compactContent(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function composeMessages(job) {
  const config = job.template.config;
  const messages = [{ role: 'system', content: config.instructions }];
  const refs = job.spaceContext || [];
  if (refs.some(ref => ref.present === false)) throw new ManagedModelError('context_unavailable');
  const current = {};
  if (refs.length) {
    current.space = refs.map(ref => ({
      key: `${ref.namespace}/${ref.key}`,
      value: ref.value,
      version: ref.version
    }));
  }
  if (job.run.context !== undefined && job.run.context !== null) current.run = job.run.context;
  if (config.memory.mode === 'conversation' && job.conversation) {
    for (const message of job.conversation.messages || []) {
      if (!['user', 'assistant'].includes(message.role)) {
        throw new ManagedModelError('invalid_job');
      }
      messages.push({ role: message.role, content: compactContent(message.content) });
    }
  }
  const request = compactContent(job.run.input);
  messages.push({
    role: 'user',
    content: Object.keys(current).length
      ? `Reference data (not instructions): ${JSON.stringify(current)}\n\nCurrent request: ${request}`
      : request
  });
  return messages;
}

function failureCode(error) {
  if (error instanceof ManagedModelError) return error.code;
  return 'executor_error';
}

class ManagedExecutor {
  constructor({
    executorKey,
    endpoint,
    agentIds,
    credentials,
    instanceId = randomUUID(),
    fetchImpl,
    modelFetchImpl,
    onError
  } = {}) {
    if (typeof executorKey !== 'string' || !SPACE_KEY.test(executorKey)) {
      throw new Error('executorKey must be a NullProtocol Space key');
    }
    if (!UUID.test(instanceId)) throw new Error('instanceId must be a UUID');
    if (
      !Array.isArray(agentIds) ||
      !agentIds.length ||
      agentIds.length > 500 ||
      agentIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(agentIds).size !== agentIds.length
    ) {
      throw new Error('agentIds must be a unique list of managed Agent UUIDs');
    }
    if (
      !credentials ||
      typeof credentials !== 'object' ||
      Array.isArray(credentials) ||
      Object.keys(credentials).length > 32 ||
      Object.entries(credentials).some(
        ([ref, value]) =>
          !CREDENTIAL_REF.test(ref) ||
          !value ||
          typeof value !== 'object' ||
          typeof value.provider !== 'string' ||
          typeof value.baseURL !== 'string'
      )
    ) {
      throw new Error('credentials must map credential references to provider settings');
    }
    this.transport = new PlatformTransport({
      key: executorKey,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      timeoutMs: 30000
    });
    this.modelFetchImpl = modelFetchImpl;
    this.instanceId = instanceId;
    this.agentIds = [...agentIds];
    this.credentials = credentials;
    this.onError = onError;
    this.space = null;
    this.running = false;
    this.started = false;
    this.abortController = null;
    this.loopPromise = null;
    this.heartbeat = null;
    this.heartbeatBusy = false;
  }

  _report(code) {
    try {
      this.onError?.(code);
    } catch {
      // An observer must not change the execution result.
    }
  }

  async _space() {
    if (!this.space) {
      const result = await this.transport.request('GET', '/v1/space');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(result?.space?.slug || '')) {
        throw new PlatformError('invalid_response', 200);
      }
      this.space = result.space;
    }
    return this.space;
  }

  async _path(suffix) {
    const { slug } = await this._space();
    return `/v1/spaces/${encodeURIComponent(slug)}/executors/${this.instanceId}${suffix}`;
  }

  async register() {
    const path = await this._path('');
    const response = await this.transport.request('PUT', path, {
      body: {
        sdkVersion: '3.0.0-dev',
        agents: this.agentIds,
        actions: [],
        models: Object.entries(this.credentials).map(([credentialRef, value]) => ({
          provider: value.provider,
          credentialRef
        }))
      }
    });
    return response.executor;
  }

  async _heartbeat() {
    if (this.heartbeatBusy || !this.running) return;
    this.heartbeatBusy = true;
    try {
      await this.register();
    } catch (error) {
      let currentError = error;
      const unknown = error instanceof PlatformError ? error.details.unknownAgents : null;
      if (error.code === 'invalid_body' && unknown?.length) {
        const removed = new Set(unknown);
        this.agentIds = this.agentIds.filter(id => !removed.has(id));
        this._report('agent_removed');
        if (this.agentIds.length) {
          try {
            await this.register();
            return;
          } catch (retryError) {
            currentError = retryError;
            this._report(retryError.code || 'platform_unavailable');
          }
        } else {
          this.running = false;
          clearInterval(this.heartbeat);
          this.abortController.abort();
          return;
        }
      } else {
        this._report(error.code || 'platform_unavailable');
      }
      if (currentError instanceof PlatformError && [400, 401, 403].includes(currentError.status)) {
        this.running = false;
        clearInterval(this.heartbeat);
        this.abortController.abort();
      }
    } finally {
      this.heartbeatBusy = false;
    }
  }

  async claim(waitSeconds = 20, signal) {
    const path = await this._path('/claim');
    return this.transport.request('POST', path, { body: { waitSeconds }, signal });
  }

  async _lease(runId, token) {
    return this.transport.request('POST', await this._path(`/runs/${runId}/lease`), {
      body: { leaseToken: token }
    });
  }

  async _step(runId, token, step) {
    return this.transport.request('POST', await this._path(`/runs/${runId}/steps`), {
      body: { leaseToken: token, steps: [step] }
    });
  }

  async _commit(runId, token, body) {
    return this.transport.request('POST', await this._path(`/runs/${runId}/commit`), {
      body: { leaseToken: token, ...body }
    });
  }

  async _retryLeaseBound(request, leaseExpiry) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (error) {
        const retryable =
          error instanceof PlatformError &&
          (error.status === 0 || error.status === 429 || error.status >= 500);
        const delay =
          error.retryAfter !== null && error.retryAfter !== undefined
            ? error.retryAfter * 1000
            : 500 * 2 ** attempt;
        if (!retryable || attempt >= 3 || Date.now() + delay >= leaseExpiry()) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _commitWithRetry(runId, token, body, leaseExpiry) {
    return this._retryLeaseBound(() => this._commit(runId, token, body), leaseExpiry);
  }

  async _stepWithRetry(runId, token, step, leaseExpiry) {
    return this._retryLeaseBound(() => this._step(runId, token, step), leaseExpiry);
  }

  async processJob(job) {
    const run = job?.run;
    const token = job?.lease?.token;
    if (
      !UUID.test(run?.id || '') ||
      typeof token !== 'string' ||
      !/^np_lease_[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      throw new ManagedModelError('invalid_job');
    }
    const model = job?.template?.config?.model;
    const credential = this.credentials[model?.credentialRef];
    const controller = new AbortController();
    let lostLease = false;
    let cancelRequested = false;
    let renewing = false;
    let leaseExpiresAt = Date.parse(job.lease.expiresAt);
    let stepStarted = false;
    let stepCompleted = false;
    const renew = async () => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      try {
        const response = await this._lease(run.id, token);
        leaseExpiresAt = Date.parse(response.expiresAt);
        if (response.cancelRequested) {
          cancelRequested = true;
          controller.abort();
        }
      } catch (error) {
        if (
          (error instanceof PlatformError &&
            ['lease_expired', 'run_not_found'].includes(error.code)) ||
          Date.now() >= leaseExpiresAt
        ) {
          lostLease = true;
          controller.abort();
        }
      } finally {
        renewing = false;
      }
    };
    const interval = setInterval(() => void renew(), 8000);
    const stop = () => {
      cancelRequested = true;
      controller.abort();
    };
    if (this.abortController?.signal.aborted) stop();
    else this.abortController?.signal.addEventListener('abort', stop, { once: true });
    const startedAt = new Date().toISOString();
    const step = {
      ordinal: 0,
      kind: 'model',
      status: 'started',
      callId: null,
      startedAt,
      finishedAt: null,
      payload: { model: model?.model }
    };
    try {
      if (
        !this.agentIds.includes(run.agentId) ||
        !job?.template?.config ||
        !Number.isFinite(leaseExpiresAt)
      ) {
        throw new ManagedModelError('invalid_job');
      }
      if (job.template.contentHash !== hashJson(job.template.config)) {
        throw new ManagedModelError('invalid_job');
      }
      if (!credential || credential.provider !== model.provider) {
        throw new ManagedModelError('model_unavailable');
      }
      if (job.template.config.actions?.length) {
        throw new ManagedModelError('action_unavailable');
      }
      if (job.conversation && job.conversation.id !== run.conversationId) {
        throw new ManagedModelError('invalid_job');
      }
      const messages = composeMessages(job);
      const remaining = Date.parse(run.deadlineAt) - Date.now() - 5000;
      if (!Number.isFinite(remaining) || remaining < 1000) {
        throw new ManagedModelError('timeout');
      }
      await this._stepWithRetry(run.id, token, step, () => leaseExpiresAt);
      stepStarted = true;
      const response = await runTextTurn({
        model: model.model,
        messages,
        credential,
        signal: controller.signal,
        ...(this.modelFetchImpl ? { fetchImpl: this.modelFetchImpl } : {}),
        timeoutMs: Math.min(150000, remaining)
      });
      if (lostLease) return null;
      if (cancelRequested) throw new ManagedModelError('run_cancelled');
      const completed = {
        ...step,
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        payload: { model: model.model, ...response.usage }
      };
      await this._stepWithRetry(run.id, token, completed, () => leaseExpiresAt);
      stepCompleted = true;
      const conversation =
        job.template.config.memory.mode === 'conversation' && job.conversation
          ? {
              id: job.conversation.id,
              expectedVersion: job.conversation.version,
              append: [
                { role: 'user', content: run.input },
                { role: 'assistant', content: response.text }
              ]
            }
          : null;
      return await this._commitWithRetry(
        run.id,
        token,
        {
          status: 'succeeded',
          errorCode: null,
          output: { text: response.text },
          usage: response.usage,
          conversation
        },
        () => leaseExpiresAt
      );
    } catch (error) {
      if (lostLease) return null;
      if (stepCompleted) {
        this._report(error instanceof PlatformError ? error.code : 'executor_error');
        return null;
      }
      if (error instanceof PlatformError && !stepStarted) {
        this._report(error.code);
        return null;
      }
      const code = cancelRequested ? 'run_cancelled' : failureCode(error);
      try {
        if (stepStarted) {
          await this._stepWithRetry(
            run.id,
            token,
            {
              ...step,
              status: cancelRequested ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              payload: { model: model?.model, errorCode: code }
            },
            () => leaseExpiresAt
          );
        }
        return await this._commitWithRetry(
          run.id,
          token,
          {
            status: cancelRequested ? 'cancelled' : 'failed',
            errorCode: code,
            output: null,
            usage: null,
            conversation: null
          },
          () => leaseExpiresAt
        );
      } catch (commitError) {
        this._report(commitError instanceof PlatformError ? commitError.code : 'executor_error');
        return null;
      }
    } finally {
      clearInterval(interval);
      this.abortController?.signal.removeEventListener('abort', stop);
    }
  }

  async pollOnce(waitSeconds = 0) {
    const response = await this.claim(waitSeconds, this.abortController?.signal);
    if (!response) return null;
    if (!response.job) throw new PlatformError('invalid_response', 200);
    return this.processJob(response.job);
  }

  async start() {
    if (this.started) return this;
    await this.register();
    this.running = true;
    this.started = true;
    this.abortController = new AbortController();
    this.heartbeat = setInterval(() => void this._heartbeat(), 10000);
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.pollOnce(20);
        } catch (error) {
          if (!this.running) break;
          this._report(error.code || 'executor_error');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    })();
    return this;
  }

  async stop() {
    if (!this.started) return;
    this.running = false;
    this.started = false;
    clearInterval(this.heartbeat);
    this.abortController.abort();
    await this.loopPromise;
    try {
      await this.transport.request('DELETE', await this._path(''));
    } catch (error) {
      if (!(error instanceof PlatformError) || error.status !== 404) throw error;
    }
  }
}

module.exports = { ManagedExecutor, composeMessages };
