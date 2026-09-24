const SEGMENT = /^[a-z][a-z0-9._-]{0,63}$/;
const TOKEN = /^np_ctx_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SpaceContextError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'SpaceContextError';
    this.status = status;
    this.code = code;
  }
}

class SpaceContextClient {
  constructor({ key, endpoint, fetchImpl = fetch } = {}) {
    if (typeof key !== 'string' || !TOKEN.test(key)) {
      throw new Error('spaceContextKey must be a NullProtocol context key');
    }
    if (typeof endpoint !== 'string') {
      throw new Error('spaceContextEndpoint is required');
    }
    const url = new URL(endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('spaceContextEndpoint must be an HTTPS origin or local HTTP origin');
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
    this.key = key;
    this.origin = url.origin;
    this.fetchImpl = fetchImpl;
  }

  async request(namespace, key, method, body) {
    if (!SEGMENT.test(namespace) || !SEGMENT.test(key)) {
      throw new Error('Space context namespace and key must be lowercase slugs');
    }
    const response = await this.fetchImpl(`${this.origin}/v1/context/${namespace}/${key}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
    const text = await response.text();
    if (text.length > 16384) throw new SpaceContextError(response.status, 'invalid_response');
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new SpaceContextError(response.status, 'invalid_response');
    }
    if (!response.ok) {
      if (response.status === 404 && method === 'GET' && result?.error === 'not_found') return null;
      const code = typeof result?.error === 'string' ? result.error : 'request_failed';
      throw new SpaceContextError(response.status, code);
    }
    return result;
  }

  async get(namespace, key) {
    const result = await this.request(namespace, key, 'GET');
    return result?.document || null;
  }

  async put(namespace, key, value, { ifVersion, ttlSeconds } = {}) {
    if (ifVersion !== null && (typeof ifVersion !== 'string' || !UUID.test(ifVersion))) {
      throw new Error('ifVersion must be null for creation or a version from get()');
    }
    if (
      ttlSeconds !== undefined &&
      ttlSeconds !== null &&
      (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 30 * 86400)
    ) {
      throw new Error('ttlSeconds must be 1 through 2592000 or null');
    }
    const result = await this.request(namespace, key, 'PUT', {
      value,
      ifVersion,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds })
    });
    return result.document;
  }

  async delete(namespace, key, ifVersion) {
    if (typeof ifVersion !== 'string' || !UUID.test(ifVersion)) {
      throw new Error('ifVersion must be a version from get()');
    }
    await this.request(namespace, key, 'DELETE', { ifVersion });
  }
}

module.exports = { SpaceContextClient, SpaceContextError };
