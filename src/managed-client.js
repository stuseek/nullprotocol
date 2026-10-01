const { PlatformTransport, PlatformError } = require('./managed-http');
const { ManagedActionRegistry } = require('./managed-actions');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPACE_KEY = /^np_space_[A-Za-z0-9_-]{43}$/;

function resourceId(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function versionId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('version must be a positive integer');
  }
  return String(value);
}

function actionName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new Error('actionName is invalid');
  }
  return value;
}

function stepOrdinal(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error('step ordinal must be an integer from 0 to 255');
  }
  return value;
}

function contextKey(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('contextKey is invalid');
  }
  return value;
}

function conversationKey(value) {
  if (typeof value !== 'string') throw new Error('conversationKey must be a string');
  const normalized = value.normalize('NFC');
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 256 || /[\p{Cc}]/u.test(normalized)) {
    throw new Error('conversationKey is invalid');
  }
  // URLs resolve "." and ".." (even percent-encoded) as path steps, so such a key
  // would address another route.
  if (normalized === '.' || normalized === '..') {
    throw new Error('conversationKey cannot be "." or ".."');
  }
  return encodeURIComponent(normalized);
}

function messageSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('message sequence must be a positive integer');
  }
  return value;
}

function idempotencyHeaders(key) {
  if (key === undefined) return {};
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new Error('idempotencyKey must be 1–128 printable ASCII characters without spaces');
  }
  return { 'Idempotency-Key': key };
}

function queryPath(path, params) {
  const query = new globalThis.URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function runBody(input, options) {
  if (input === undefined) throw new Error('input is required');
  return {
    input,
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.subject === undefined ? {} : { subject: options.subject })
  };
}

function templateBody(body) {
  if (!body?.config || !Array.isArray(body.config.actions)) return body;
  if (!body.config.actions.some(action => typeof action?.handler === 'function')) return body;
  new ManagedActionRegistry(
    body.config.actions.filter(action => typeof action?.handler === 'function')
  );
  return {
    ...body,
    config: {
      ...body.config,
      actions: body.config.actions.map(
        ({ handler: _handler, guard: _guard, ...contract }) => contract
      )
    }
  };
}

function waitDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlatformError('request_aborted', 0));
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new PlatformError('request_aborted', 0));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

class NullProtocolClient {
  constructor({ spaceKey, endpoint, fetchImpl, timeoutMs } = {}) {
    if (typeof spaceKey !== 'string' || !SPACE_KEY.test(spaceKey)) {
      throw new Error('spaceKey must be a NullProtocol Space key');
    }
    this.transport = new PlatformTransport({
      key: spaceKey,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    });
    this.spacePromise = null;
    this.templates = {
      create: async (body, options = {}) =>
        this._request('POST', 'templates', {
          body: templateBody(body),
          headers: idempotencyHeaders(options.idempotencyKey),
          signal: options.signal
        }),
      list: async (query = {}, options = {}) =>
        this._request('GET', queryPath('templates', query), options),
      get: async (id, options = {}) =>
        this._request('GET', `templates/${resourceId(id, 'templateId')}`, options),
      update: async (id, body, options = {}) =>
        this._request('PATCH', `templates/${resourceId(id, 'templateId')}`, { ...options, body }),
      publishVersion: async (id, body, options = {}) =>
        this._request('POST', `templates/${resourceId(id, 'templateId')}/versions`, {
          ...options,
          body: templateBody(body)
        }),
      listVersions: async (id, query = {}, options = {}) =>
        this._request(
          'GET',
          queryPath(`templates/${resourceId(id, 'templateId')}/versions`, query),
          options
        ),
      getVersion: async (id, version, options = {}) =>
        this._request(
          'GET',
          `templates/${resourceId(id, 'templateId')}/versions/${versionId(version)}`,
          options
        ),
      delete: async (id, options = {}) =>
        this._request('DELETE', `templates/${resourceId(id, 'templateId')}`, options)
    };
    this.agents = {
      create: async (body, options = {}) =>
        this._request('POST', 'managed-agents', {
          body,
          headers: idempotencyHeaders(options.idempotencyKey),
          signal: options.signal
        }),
      list: async (query = {}, options = {}) =>
        this._request('GET', queryPath('managed-agents', query), options),
      get: async (id, options = {}) =>
        this._request('GET', `managed-agents/${resourceId(id, 'agentId')}`, options),
      update: async (id, body, options = {}) =>
        this._request('PATCH', `managed-agents/${resourceId(id, 'agentId')}`, { ...options, body }),
      setAction: async (id, name, body, options = {}) =>
        this._request(
          'PATCH',
          `managed-agents/${resourceId(id, 'agentId')}/actions/${actionName(name)}`,
          { ...options, body }
        ),
      stop: async (id, body, options = {}) =>
        this._request('POST', `managed-agents/${resourceId(id, 'agentId')}/stop`, {
          ...options,
          body
        }),
      delete: async (id, options = {}) =>
        this._request('DELETE', `managed-agents/${resourceId(id, 'agentId')}`, options),
      run: (id, input, options = {}) => this.agent(id).run(input, options)
    };
  }

  async _discoverSpace(signal) {
    const result = await this.transport.request('GET', '/v1/space', { signal });
    const slug = result?.space?.slug;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
      throw new PlatformError('invalid_response', 200);
    }
    return result.space;
  }

  async space({ signal } = {}) {
    if (signal) return this._discoverSpace(signal);
    if (!this.spacePromise) {
      this.spacePromise = this._discoverSpace().catch(error => {
        this.spacePromise = null;
        throw error;
      });
    }
    return this.spacePromise;
  }

  usage(options = {}) {
    return this._request('GET', 'managed-usage', options);
  }

  agent(id) {
    const encoded = resourceId(id, 'agentId');
    const agentPath = `managed-agents/${encoded}`;
    const runPath = `managed-agents/${encoded}/runs`;
    return {
      context: {
        list: (options = {}) => this._request('GET', `${agentPath}/context`, options),
        get: (key, options = {}) =>
          this._request('GET', `${agentPath}/context/${contextKey(key)}`, options),
        put: (key, body, options = {}) =>
          this._request('PUT', `${agentPath}/context/${contextKey(key)}`, { ...options, body }),
        delete: (key, body, options = {}) =>
          this._request('DELETE', `${agentPath}/context/${contextKey(key)}`, { ...options, body })
      },
      memory: {
        add: (body, options = {}) =>
          this._request('POST', `${agentPath}/memory`, { ...options, body }),
        list: (options = {}) => this._request('GET', `${agentPath}/memory`, options),
        delete: (entryId, options = {}) =>
          this._request('DELETE', `${agentPath}/memory/${resourceId(entryId, 'entryId')}`, options)
      },
      conversations: {
        list: (query = {}, options = {}) =>
          this._request('GET', queryPath(`${agentPath}/conversations`, query), options),
        get: (key, query = {}, options = {}) =>
          this._request(
            'GET',
            queryPath(`${agentPath}/conversations/${conversationKey(key)}`, query),
            options
          ),
        delete: (key, options = {}) =>
          this._request('DELETE', `${agentPath}/conversations/${conversationKey(key)}`, options),
        deleteMessage: (key, seq, options = {}) =>
          this._request(
            'DELETE',
            `${agentPath}/conversations/${conversationKey(key)}/messages/${messageSequence(seq)}`,
            options
          ),
        deleteFact: (key, factId, options = {}) =>
          this._request(
            'DELETE',
            `${agentPath}/conversations/${conversationKey(key)}/facts/${resourceId(factId, 'factId')}`,
            options
          )
      },
      get: options => this._request('GET', `managed-agents/${encoded}`, options),
      runtime: options => this._request('GET', `${agentPath}/runtime`, options),
      update: (body, options = {}) =>
        this._request('PATCH', `managed-agents/${encoded}`, { ...options, body }),
      setAction: (name, body, options = {}) => this.agents.setAction(encoded, name, body, options),
      stop: (body, options = {}) => this.agents.stop(encoded, body, options),
      delete: options => this._request('DELETE', `managed-agents/${encoded}`, options),
      startRun: async (input, options = {}) => {
        const response = await this._request('POST', runPath, {
          body: runBody(input, options),
          headers: idempotencyHeaders(options.idempotencyKey),
          signal: options.signal
        });
        if (!response?.run?.id || !UUID.test(response.run.id)) {
          throw new PlatformError('invalid_response', 202);
        }
        return response.run;
      },
      getRun: async (runId, options = {}) => {
        const result = await this._request(
          'GET',
          `${runPath}/${resourceId(runId, 'runId')}`,
          options
        );
        return result.run;
      },
      listRuns: async (query = {}, options = {}) =>
        this._request('GET', queryPath(runPath, query), options),
      listSteps: async (runId, options = {}) =>
        this._request('GET', `${runPath}/${resourceId(runId, 'runId')}/steps`, options),
      reconcileStep: async (runId, ordinal, body, options = {}) =>
        this._request(
          'POST',
          `${runPath}/${resourceId(runId, 'runId')}/steps/${stepOrdinal(ordinal)}/reconcile`,
          { ...options, body }
        ),
      cancelRun: async (runId, options = {}) => {
        const result = await this._request(
          'POST',
          `${runPath}/${resourceId(runId, 'runId')}/cancel`,
          options
        );
        return result.run;
      },
      run: async (input, options = {}) => {
        const interval = options.pollIntervalMs ?? 2000;
        if (!Number.isSafeInteger(interval) || interval < 100 || interval > 10000) {
          throw new Error('pollIntervalMs must be between 100 and 10000');
        }
        const timeoutMs = options.waitTimeoutMs ?? 185000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) {
          throw new Error('waitTimeoutMs must be between 1 and 3600000');
        }
        const started = await this.agent(encoded).startRun(input, options);
        if (TERMINAL_RUN.has(started.status) || options.wait === false) return started;
        const deadline = Date.now() + timeoutMs;
        let current = started;
        let nextInterval = interval;
        while (!TERMINAL_RUN.has(current.status)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new PlatformError('run_wait_timeout', 0, { runId: started.id });
          }
          await waitDelay(Math.min(nextInterval, remaining), options.signal);
          try {
            current = await this.agent(encoded).getRun(started.id, { signal: options.signal });
          } catch (error) {
            if (!(error instanceof PlatformError) || error.status !== 429) throw error;
            nextInterval = Math.max(nextInterval, (error.retryAfter ?? 5) * 1000);
            continue;
          }
          if (!current || current.id !== started.id || typeof current.status !== 'string') {
            throw new PlatformError('invalid_response', 200);
          }
          nextInterval = Math.min(5000, Math.ceil(nextInterval * 1.5));
        }
        return current;
      }
    };
  }

  async _request(method, suffix, options) {
    const { slug } = await this.space({ signal: options?.signal });
    return this.transport.request(
      method,
      `/v1/spaces/${encodeURIComponent(slug)}/${suffix}`,
      options
    );
  }
}

module.exports = { NullProtocolClient };
