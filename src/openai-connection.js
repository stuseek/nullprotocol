// Connects an application's own OpenAI client to a NullProtocol Space. Each
// chat.completions.create call made through it is reported as one model.call
// event and, with a runtime key, can be paused and stopped from the cabinet.
// Parameters, the client's retries and timeout, completions and errors stay the
// SDK's own; a stream comes back as an async iterable of its chunks.

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
const { TelemetryClient, modelLabel } = require('./telemetry');
const { ClientControl, ControlError } = require('./runtime-control');

// An abort controller that follows the given signals until it is released.
// Node 18 has no AbortSignal.any.
function follow(signals) {
  const controller = new AbortController();
  const listeners = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  const release = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  };
  return { controller, release };
}

// Token counts as the telemetry API accepts them; a missing or invalid count is
// left out, never sent as zero.
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}

function tokens(usage) {
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  };
}

// The chunks of a stream as an async iterable that ends the call when the stream
// ends, fails or is cancelled. The SDK may stop following the request signal once
// the answer has started, so a cancellation aborts the stream's own controller,
// which closes the connection, and ends the call at once, read or not.
function chunks(stream, controller, end, failure) {
  const iterator = stream[Symbol.asyncIterator]();
  let usage;
  const finish = fields => {
    controller.signal.removeEventListener('abort', cancel);
    end({ ...fields, ...tokens(usage) });
  };
  function cancel() {
    stream.controller.abort();
    finish({ success: false, errorCode: 'aborted' });
  }
  if (controller.signal.aborted) cancel();
  else controller.signal.addEventListener('abort', cancel, { once: true });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      let step;
      try {
        step = await iterator.next();
      } catch (error) {
        finish(failure(error, true));
        throw error;
      }
      if (!step.done) {
        if (step.value?.usage) usage = step.value.usage;
        return step;
      }
      // The SDK ends an aborted stream quietly; a cut answer is not a short one.
      if (controller.signal.aborted) throw controller.signal.reason;
      finish({ success: true });
      return step;
    },
    async return(value) {
      try {
        controller.abort(Object.assign(new Error('Stream closed'), { name: 'AbortError' }));
        await iterator.return();
      } finally {
        finish({ success: false, errorCode: 'aborted' });
      }
      return { done: true, value };
    }
  };
}

function connectOpenAI(client, options = {}) {
  if (typeof client?.chat?.completions?.create !== 'function') {
    throw new TypeError('connectOpenAI needs an OpenAI client');
  }
  const { agentId, telemetryKey, telemetryEndpoint, runtimeKey, runtimeEndpoint } = options;
  if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentId)) {
    throw new Error('agentId must be a stable lowercase slug (up to 64 characters)');
  }
  if (!telemetryKey || !telemetryEndpoint) {
    throw new Error('connectOpenAI needs telemetryKey and telemetryEndpoint');
  }
  if (!!runtimeKey !== !!runtimeEndpoint) {
    throw new Error('Runtime control requires both runtimeKey and runtimeEndpoint');
  }
  const runs = new AsyncLocalStorage();
  const telemetry = new TelemetryClient({
    token: telemetryKey,
    endpoint: telemetryEndpoint,
    agentId,
    currentRunId: () => runs.getStore()
  });
  // Each request names its own model, so the cabinet is told none.
  const control = runtimeKey
    ? new ClientControl(runtimeKey, runtimeEndpoint, {
        id: agentId,
        mode: 'stateless',
        model: null,
        operations: ['chat']
      })
    : null;
  // The error classes of the SDK the application passed in.
  const { APIError, APIConnectionTimeoutError } = client.constructor ?? {};
  // close() aborts this, which cancels every call that is waiting or running.
  const shutdown = new AbortController();
  const pending = new Set();
  let closing = null;
  let closed = false;

  async function call(params, requestOptions) {
    const runId = randomUUID();
    const started = Date.now();
    const model = modelLabel(params?.model);
    const record = fields => {
      if (closed) return;
      runs.run(runId, () =>
        telemetry.track('model.call', {
          ...(model ? { model } : {}),
          duration: Date.now() - started,
          ...fields
        })
      );
    };

    let run = null;
    if (control) {
      const waiting = follow([requestOptions.signal, shutdown.signal]);
      try {
        run = await control.begin(waiting.controller.signal);
      } catch (error) {
        // A refusal sends no request; a caller abort while waiting is a cancellation.
        record({
          success: false,
          errorCode: error instanceof ControlError ? error.code : 'aborted'
        });
        throw error;
      } finally {
        waiting.release();
      }
    }

    const { controller, release } = follow([requestOptions.signal, run?.signal, shutdown.signal]);
    let ended = false;
    // Each call is recorded once, by whichever outcome comes first.
    const end = fields => {
      if (ended) return;
      ended = true;
      release();
      if (run) control.end(run);
      record(fields);
    };
    // Before an answer, only the SDK's own API and connection errors are the
    // provider's; any other exception, such as a TypeError for invalid params, is
    // internal. While an answer is being read, a failure is the provider's.
    const failure = (error, reading = false) => {
      let errorCode = reading ? 'provider_error' : 'internal';
      if (controller.signal.aborted) errorCode = 'aborted';
      else if (error?.status === 429) errorCode = 'rate_limited';
      else if (APIConnectionTimeoutError && error instanceof APIConnectionTimeoutError) {
        errorCode = 'timeout';
      } else if (APIError && error instanceof APIError) errorCode = 'provider_error';
      return { success: false, errorCode };
    };

    let value;
    try {
      value = await client.chat.completions.create(params, {
        ...requestOptions,
        signal: controller.signal
      });
    } catch (error) {
      end(failure(error));
      throw error;
    }
    if (params?.stream !== true) {
      end({ success: true, ...tokens(value?.usage) });
      return value;
    }
    return chunks(value, controller, end, failure);
  }

  function create(params, requestOptions = {}) {
    if (closing) {
      return Promise.reject(new ControlError('control_closed', 'This connection was closed'));
    }
    const result = call(params, requestOptions);
    pending.add(result);
    const settle = () => pending.delete(result);
    result.then(settle, settle);
    return result;
  }

  // Cancels waiting and running calls and streams through the shutdown signal,
  // waits until each is recorded, then releases control and sends the buffered
  // events. Nothing is recorded after that.
  function close() {
    closing ||= (async () => {
      shutdown.abort(new ControlError('control_closed', 'This connection was closed'));
      await Promise.allSettled([...pending]);
      closed = true;
      control?.close();
      await telemetry.destroy();
    })();
    return closing;
  }

  return { create, close };
}

module.exports = { connectOpenAI };
