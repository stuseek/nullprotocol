/**
 * Resilience - Retry, Circuit Breaker, and Timeout for AI Toolkit
 */

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
      totalSkipped: 0
    };
  }

  /**
   * Execute a function with retry, timeout, and circuit breaker protection
   */
  async execute(fn, options = {}) {
    // Check circuit breaker
    if (this.isTripped()) {
      const cb = this.circuitBreaker;
      const elapsed = Date.now() - cb.tripTime;

      if (elapsed >= cb.resetAfterMs) {
        // Half-open: allow one attempt through
        this.reset();
      } else {
        cb.totalSkipped++;
        throw new CircuitBreakerError(cb.failures, cb.totalSkipped);
      }
    }

    let lastError;

    const maxRetries = options.maxRetries ?? this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._withTimeout(fn, options.timeout ?? this.timeout);
        this.recordSuccess();
        return result;
      } catch (error) {
        lastError = error;

        // Don't retry non-retryable errors
        if (!this._isRetryable(error)) {
          if (this._countsAsFailure(error)) this.recordFailure();
          throw error;
        }

        // Don't wait after the last attempt
        if (attempt < maxRetries) {
          const delay = this._backoffDelay(attempt);
          await this._sleep(delay);
        }
      }
    }

    // All retries exhausted
    this.recordFailure();
    throw lastError;
  }

  /**
   * Check if circuit breaker is tripped
   */
  isTripped() {
    return this.circuitBreaker.tripped;
  }

  /**
   * Reset circuit breaker
   */
  reset() {
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.tripped = false;
    this.circuitBreaker.tripTime = null;
  }

  /**
   * Record a successful call
   */
  recordSuccess() {
    this.circuitBreaker.failures = 0;
    if (this.circuitBreaker.tripped) {
      this.circuitBreaker.tripped = false;
      this.circuitBreaker.tripTime = null;
    }
  }

  /**
   * Record a failed call
   */
  recordFailure() {
    const cb = this.circuitBreaker;
    cb.failures++;

    if (cb.failures >= cb.threshold && !cb.tripped) {
      cb.tripped = true;
      cb.tripTime = Date.now();
    }
  }

  /**
   * Get circuit breaker stats
   */
  getStats() {
    const cb = this.circuitBreaker;
    return {
      failures: cb.failures,
      tripped: cb.tripped,
      totalSkipped: cb.totalSkipped,
      tripTime: cb.tripTime
    };
  }

  /**
   * Wrap a function with a timeout
   */
  _withTimeout(fn, ms) {
    if (!ms || ms <= 0) return fn();

    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        const err = new Error(`AI request timed out after ${ms}ms`);
        err.code = 'ETIMEDOUT';
        controller.abort(err);
        reject(err);
      }, ms);

      Promise.resolve()
        .then(() => fn(controller.signal))
        .then(
          result => {
            clearTimeout(timer);
            resolve(result);
          },
          error => {
            clearTimeout(timer);
            reject(error);
          }
        );
    });
  }

  /**
   * Check if an error is retryable
   */
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
    )
      return true;
    if (['APIConnectionError', 'APIConnectionTimeoutError'].includes(error.constructor?.name))
      return true;
    if (['fetch failed', 'Connection error.', 'Request timed out.'].includes(error.message))
      return true;

    // Anthropic overloaded
    if (error.message?.includes('overloaded')) return true;

    return false;
  }

  _countsAsFailure(error) {
    const status = error.status || error.statusCode || error.response?.status;
    if (status) return status === 429 || status >= 500;
    return this._isRetryable(error);
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  _backoffDelay(attempt) {
    const base = 1000 * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(base + jitter, 10000);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { Resilience, CircuitBreakerError };
