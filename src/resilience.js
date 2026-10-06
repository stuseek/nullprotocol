// Retries, timeouts and a circuit breaker around model requests.

class CircuitBreakerError extends Error {
  constructor(failures, totalSkipped) {
    super(
      `Circuit breaker open: ${failures} consecutive failures, ${totalSkipped} requests skipped`
    );
    this.name = 'CircuitBreakerError';
    this.failures = failures;
    this.totalSkipped = totalSkipped;
  }
}

function cancellationError(signal) {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  return Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
}

class Resilience {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.timeout = options.timeout ?? 30000;
    this.circuitBreaker = {
      threshold: options.circuitBreakerThreshold ?? 5,
      resetAfterMs: options.circuitBreakerResetMs ?? 60000,
      failures: 0,
      tripped: false,
      tripTime: null,
      // After the cooldown one request probes the provider while the rest are still refused.
      probing: false,
      // Counts trips and recoveries, so a request that started before one cannot undo it.
      generation: 0,
      totalSkipped: 0
    };
  }

  /**
   * Execute a function with retry, timeout, and circuit breaker protection
   */
  async execute(fn, options = {}) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    const cb = this.circuitBreaker;
    let probe = false;
    if (cb.tripped) {
      if (cb.probing || Date.now() - cb.tripTime < cb.resetAfterMs) {
        cb.totalSkipped++;
        throw new CircuitBreakerError(cb.failures, cb.totalSkipped);
      }
      // Half open: this request alone tests the provider. Its success closes the
      // breaker and its failure starts a new cooldown.
      cb.probing = true;
      probe = true;
    }
    const generation = cb.generation;
    try {
      return await this._attempts(fn, options, generation, probe);
    } finally {
      // A probe that ended without a verdict (cancelled, or refused as a client
      // error) leaves the next request to probe.
      if (probe && cb.generation === generation) cb.probing = false;
    }
  }

  async _attempts(fn, options, generation, probe) {
    let lastError;

    const maxRetries = options.maxRetries ?? this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      try {
        const result = await this._withTimeout(fn, options.timeout ?? this.timeout, options.signal);
        this.recordSuccess(generation, probe);
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        lastError = error;

        // Don't retry non-retryable errors
        if (!this._isRetryable(error)) {
          if (this._countsAsFailure(error)) this.recordFailure(generation, probe);
          throw error;
        }

        // Don't wait after the last attempt
        if (attempt < maxRetries) {
          const delay = this._backoffDelay(attempt);
          await this._sleep(delay, options.signal);
        }
      }
    }

    // All retries exhausted
    this.recordFailure(generation, probe);
    throw lastError;
  }

  isTripped() {
    return this.circuitBreaker.tripped;
  }

  reset() {
    const cb = this.circuitBreaker;
    cb.failures = 0;
    cb.tripped = false;
    cb.tripTime = null;
    cb.probing = false;
    cb.generation++;
  }

  // Called without arguments it records an outcome for the breaker's current state.
  // A request's outcome, the probe's included, counts only if no trip, recovery or
  // reset happened since it started.
  recordSuccess(generation = this.circuitBreaker.generation, probe = this.circuitBreaker.tripped) {
    const cb = this.circuitBreaker;
    if (generation !== cb.generation) return;
    if (probe) this.reset();
    else cb.failures = 0;
  }

  recordFailure(generation = this.circuitBreaker.generation, probe = false) {
    const cb = this.circuitBreaker;
    if (generation !== cb.generation) return;
    if (probe) {
      cb.tripTime = Date.now();
      cb.probing = false;
      cb.generation++;
      return;
    }
    cb.failures++;
    if (cb.failures >= cb.threshold) {
      cb.tripped = true;
      cb.tripTime = Date.now();
      cb.generation++;
    }
  }

  getStats() {
    const cb = this.circuitBreaker;
    return {
      failures: cb.failures,
      tripped: cb.tripped,
      totalSkipped: cb.totalSkipped,
      tripTime: cb.tripTime
    };
  }

  _withTimeout(fn, ms, externalSignal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        controller.abort(externalSignal.reason);
        cleanup();
        reject(cancellationError(externalSignal));
      };
      if (externalSignal?.aborted) return onAbort();
      externalSignal?.addEventListener('abort', onAbort, { once: true });
      if (ms && ms > 0) {
        timer = setTimeout(() => {
          const err = new Error(`AI request timed out after ${ms}ms`);
          err.code = 'ETIMEDOUT';
          controller.abort(err);
          cleanup();
          reject(err);
        }, ms);
      }

      Promise.resolve()
        .then(() => {
          if (externalSignal?.aborted) throw cancellationError(externalSignal);
          return fn(controller.signal);
        })
        .then(
          result => {
            cleanup();
            resolve(result);
          },
          error => {
            cleanup();
            reject(error);
          }
        );
    });
  }

  _isRetryable(error) {
    // HTTP status codes
    const status = error.status || error.statusCode || error.response?.status;
    if (status && [429, 503, 529].includes(status)) return true;

    // Network errors
    const code = error.code || error.cause?.code || error.cause?.cause?.code;
    if (
      code &&
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'EPIPE',
        'EAI_AGAIN',
        'ENOTFOUND',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET'
      ].includes(code)
    ) {
      return true;
    }
    if (['APIConnectionError', 'APIConnectionTimeoutError'].includes(error.constructor?.name)) {
      return true;
    }
    if (['fetch failed', 'Connection error.', 'Request timed out.'].includes(error.message)) {
      return true;
    }

    // Anthropic overloaded
    if (error.message?.includes('overloaded')) return true;

    return false;
  }

  _countsAsFailure(error) {
    const status = error.status || error.statusCode || error.response?.status;
    if (status) return status === 429 || status >= 500;
    return this._isRetryable(error);
  }

  // Exponential backoff with jitter.
  _backoffDelay(attempt) {
    const base = 1000 * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(base + jitter, 10000);
  }

  _sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(cancellationError(signal));
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(cancellationError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

module.exports = { Resilience, CircuitBreakerError };
