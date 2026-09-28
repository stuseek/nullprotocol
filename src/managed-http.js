const MAX_RESPONSE_BYTES = 1024 * 1024;

class PlatformError extends Error {
  constructor(code, status, details = {}, retryAfter = null) {
    super(code);
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

function endpointOrigin(endpoint) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password
  ) {
    throw new Error('Platform endpoint must use HTTPS or loopback HTTP without URL credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Platform endpoint must be an origin without a path, query, or fragment');
  }
  return url.origin;
}

async function readBoundedJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new PlatformError('response_too_large', response.status);
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new PlatformError('response_too_large', response.status);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks, size).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new PlatformError('response_too_large', response.status);
    }
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformError('invalid_response', response.status);
  }
}

class PlatformTransport {
  constructor({
    endpoint = 'https://api.nullprotocol.ai',
    key,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000
  }) {
    this.origin = endpointOrigin(endpoint);
    if (typeof key !== 'string' || !key.trim()) throw new Error('Platform key is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw new Error('timeoutMs must be an integer from 1 to 120000');
    }
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, signal, headers = {} } = {}) {
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      throw new Error('Unsupported platform HTTP method');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Platform path must start with one slash');
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Platform path cannot change origin');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Platform request timeout')),
      this.timeoutMs
    );
    try {
      let encodedBody;
      if (body !== undefined) {
        try {
          encodedBody = JSON.stringify(body);
        } catch {
          throw new PlatformError('invalid_request_body', 0);
        }
      }
      const outboundHeaders = new globalThis.Headers(headers);
      outboundHeaders.set('Accept', 'application/json');
      if (body !== undefined) outboundHeaders.set('Content-Type', 'application/json');
      outboundHeaders.set('Authorization', `Bearer ${this.key}`);
      const response = await this.fetchImpl(url.href, {
        method,
        headers: outboundHeaders,
        ...(body === undefined ? {} : { body: encodedBody }),
        signal: controller.signal,
        redirect: 'error'
      });
      const data = await readBoundedJson(response);
      if (!response.ok) {
        const code =
          (typeof data?.error === 'string' ? data.error : data?.error?.code) || data?.code;
        const safeCode =
          typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'platform_error';
        const details = {};
        for (const field of ['latestVersion', 'revision', 'limit', 'used']) {
          if (Number.isSafeInteger(data?.[field]) && data[field] >= 0) details[field] = data[field];
        }
        if (
          typeof data?.resource === 'string' &&
          /^(activeRuns|runsPerDay|conversations|storageBytes|templates|managedAgents|conversationFacts|agentContextEntries|agentContextBytes|agentMemoryEntries|agentMemoryBytes)$/.test(
            data.resource
          )
        ) {
          details.resource = data.resource;
        }
        if (Array.isArray(data?.unknownAgents)) {
          const ids = data.unknownAgents;
          if (
            ids.length <= 500 &&
            ids.every(
              id =>
                typeof id === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
            )
          ) {
            details.unknownAgents = ids;
          }
        }
        const retryHeader = response.headers?.get?.('retry-after');
        const retryAfter =
          retryHeader && /^\d{1,6}$/.test(retryHeader) ? Number(retryHeader) : null;
        throw new PlatformError(safeCode, response.status, details, retryAfter);
      }
      if (data === null && response.status !== 204) {
        throw new PlatformError('invalid_response', response.status);
      }
      return data;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      if (controller.signal.aborted) {
        throw new PlatformError(signal?.aborted ? 'request_aborted' : 'platform_timeout', 0);
      }
      throw new PlatformError('platform_unavailable', 0);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

module.exports = { PlatformTransport, PlatformError };
