const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;

class ManagedModelError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ManagedModelError';
    this.code = code;
  }
}

function completionUrl(baseURL, allowInsecureHttp) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new ManagedModelError('model_unavailable');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ManagedModelError('model_unavailable');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
  return url.href;
}

async function boundedResponse(response) {
  const sizeHeader = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(sizeHeader) && sizeHeader > MAX_RESPONSE_BYTES) {
    throw new ManagedModelError('model_response_too_large');
  }
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > MAX_RESPONSE_BYTES) {
      throw new ManagedModelError('model_response_too_large');
    }
    return value;
  }
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
        throw new ManagedModelError('model_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One text turn against an OpenAI-compatible provider. Credentials stay in the executor. */
async function runTextTurn({
  model,
  messages,
  credential,
  signal,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60000
}) {
  if (!credential || typeof credential !== 'object' || typeof fetchImpl !== 'function') {
    throw new ManagedModelError('model_unavailable');
  }
  if (typeof model !== 'string' || !model || !Array.isArray(messages) || !messages.length) {
    throw new ManagedModelError('invalid_model_request');
  }
  if (
    messages.some(
      message =>
        !message ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string'
    )
  ) {
    throw new ManagedModelError('invalid_model_request');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) {
    throw new ManagedModelError('invalid_model_request');
  }
  if (signal?.aborted) throw new ManagedModelError('run_cancelled');
  const url = completionUrl(credential.baseURL, credential.allowInsecureHttp === true);
  const body = JSON.stringify({ model, messages, max_tokens: 1024 });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw new ManagedModelError('model_context_too_large');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Model timeout')), timeoutMs);
  try {
    const headers = new globalThis.Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    });
    if (credential.apiKey) headers.set('Authorization', `Bearer ${credential.apiKey}`);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error'
    });
    const raw = await boundedResponse(response);
    if (!response.ok) {
      throw new ManagedModelError(response.status === 429 ? 'model_rate_limited' : 'model_error');
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ManagedModelError('invalid_model_response');
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ManagedModelError('invalid_model_response');
    }
    const inputTokens = tokenCount(data?.usage?.prompt_tokens);
    const outputTokens = tokenCount(data?.usage?.completion_tokens);
    return {
      text,
      usage: inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens }
    };
  } catch (error) {
    if (error instanceof ManagedModelError) throw error;
    if (controller.signal.aborted) {
      throw new ManagedModelError(signal?.aborted ? 'run_cancelled' : 'model_timeout');
    }
    throw new ManagedModelError('model_unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { runTextTurn, ManagedModelError };
