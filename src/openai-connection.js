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

function tokens(usage) {
  return {
    ...(Number.isSafeInteger(usage?.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}),
    ...(Number.isSafeInteger(usage?.completion_tokens)
      ? { outputTokens: usage.completion_tokens }
      : {})
  };
}

// The chunks of a stream as an async iterable that ends the call when the stream
// ends, fails or is closed. Closing it, also before the first read, closes the
// connection; the SDK's own stream only does that once reading has started.
function chunks(stream, controller, end, failure) {
  const iterator = stream[Symbol.asyncIterator]();
  let usage;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      let step;
      try {
        step = await iterator.next();
      } catch (error) {
        end(failure(error));
        throw error;
      }
      if (!step.done) {
        if (step.value?.usage) usage = step.value.usage;
        return step;
      }
      // The SDK ends an aborted stream quietly; a cut answer is not a short one.
      if (controller.signal.aborted) {
        end({ success: false, errorCode: 'aborted' });
        throw controller.signal.reason;
      }
      end({ success: true, ...tokens(usage) });
      return step;
    },
    async return(value) {
      controller.abort(Object.assign(new Error('Stream closed'), { name: 'AbortError' }));
      await iterator.return?.().catch(() => {});
      end({ success: false, errorCode: 'aborted' });
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
  // The timeout error class of the SDK the application passed in.
  const Timeout = client.constructor?.APIConnectionTimeoutError;
  // Cancels each call in flight and each stream not yet ended.
  const open = new Set();
  let closed = false;

  async function create(params, requestOptions = {}) {
    if (closed) throw new ControlError('control_closed', 'This connection was closed');
    const runId = randomUUID();
    const started = Date.now();
    const model = modelLabel(params?.model);
    // One model.call per create, and none once the connection is closed.
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
      try {
        run = await control.begin(requestOptions.signal);
      } catch (error) {
        // A refusal sends no request; a caller abort while waiting is a cancellation.
        record({
          success: false,
          errorCode: error instanceof ControlError ? error.code : 'aborted'
        });
        throw error;
      }
    }

    const { controller, release } = follow([requestOptions.signal, run?.signal]);
    let ended = false;
    const end = fields => {
      if (ended) return;
      ended = true;
      release();
      open.delete(cancel);
      if (run) control.end(run);
      record(fields);
    };
    const cancel = () => {
      controller.abort(new ControlError('control_closed', 'This connection was closed'));
      end({ success: false, errorCode: 'aborted' });
    };
    open.add(cancel);
    const failure = error => {
      let errorCode = 'provider_error';
      if (controller.signal.aborted) errorCode = 'aborted';
      else if (error?.status === 429) errorCode = 'rate_limited';
      else if (Timeout && error instanceof Timeout) errorCode = 'timeout';
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

  // Cancels calls in flight and unread streams, releases the control connection
  // and sends the events recorded so far.
  async function close() {
    if (closed) return;
    closed = true;
    for (const cancel of [...open]) cancel();
    control?.close();
    await telemetry.destroy();
  }

  return { create, close };
}

module.exports = { connectOpenAI };
