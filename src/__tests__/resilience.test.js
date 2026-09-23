const { Resilience, CircuitBreakerError } = require('../resilience');

describe('Resilience', () => {
  describe('constructor defaults', () => {
    test('uses default values', () => {
      const r = new Resilience();
      expect(r.maxRetries).toBe(2);
      expect(r.timeout).toBe(30000);
      expect(r.circuitBreaker.threshold).toBe(5);
      expect(r.circuitBreaker.resetAfterMs).toBe(60000);
      expect(r.circuitBreaker.failures).toBe(0);
      expect(r.circuitBreaker.tripped).toBe(false);
    });

    test('accepts custom values', () => {
      const r = new Resilience({
        maxRetries: 5,
        timeout: 10000,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 30000
      });
      expect(r.maxRetries).toBe(5);
      expect(r.timeout).toBe(10000);
      expect(r.circuitBreaker.threshold).toBe(3);
      expect(r.circuitBreaker.resetAfterMs).toBe(30000);
    });
  });

  describe('execute — success path', () => {
    test('returns function result on success', async () => {
      const r = new Resilience();
      const result = await r.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    test('resets failure count on success', async () => {
      const r = new Resilience();
      r.circuitBreaker.failures = 3;
      await r.execute(() => Promise.resolve('ok'));
      expect(r.circuitBreaker.failures).toBe(0);
    });
  });

  describe('execute — retry logic', () => {
    test('retries on 429 status', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      // Stub _sleep to avoid actual delays
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls < 3) {
          const err = new Error('Rate limited');
          err.status = 429;
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      };

      const result = await r.execute(fn);
      expect(result).toBe('ok');
      expect(calls).toBe(3); // 1 initial + 2 retries
    });

    test('retries on 503 status', async () => {
      const r = new Resilience({ maxRetries: 1, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls < 2) {
          const err = new Error('Service unavailable');
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('recovered');
      };

      const result = await r.execute(fn);
      expect(result).toBe('recovered');
      expect(calls).toBe(2);
    });

    test('retries on 529 status (Anthropic overloaded)', async () => {
      const r = new Resilience({ maxRetries: 1, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Overloaded');
          err.status = 529;
          return Promise.reject(err);
        }
        return Promise.resolve('done');
      };

      const result = await r.execute(fn);
      expect(result).toBe('done');
    });

    test('retries on ECONNRESET', async () => {
      const r = new Resilience({ maxRetries: 1, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Connection reset');
          err.code = 'ECONNRESET';
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      };

      const result = await r.execute(fn);
      expect(result).toBe('ok');
    });

    test('retries on ETIMEDOUT', async () => {
      const r = new Resilience({ maxRetries: 1, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Timed out');
          err.code = 'ETIMEDOUT';
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      };

      await expect(r.execute(fn)).resolves.toBe('ok');
    });

    test('retries on "overloaded" message', async () => {
      const r = new Resilience({ maxRetries: 1, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('API is overloaded'));
        }
        return Promise.resolve('ok');
      };

      await expect(r.execute(fn)).resolves.toBe('ok');
    });

    test('does NOT retry on 400 Bad Request', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      r._sleep = () => Promise.resolve();

      let calls = 0;
      const fn = () => {
        calls++;
        const err = new Error('Bad request');
        err.status = 400;
        return Promise.reject(err);
      };

      await expect(r.execute(fn)).rejects.toThrow('Bad request');
      expect(calls).toBe(1); // no retries
    });

    test('does NOT retry on 401 Unauthorized', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      let calls = 0;
      const fn = () => {
        calls++;
        const err = new Error('Unauthorized');
        err.status = 401;
        return Promise.reject(err);
      };

      await expect(r.execute(fn)).rejects.toThrow('Unauthorized');
      expect(calls).toBe(1);
    });

    test('does NOT retry on generic errors', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      let calls = 0;
      const fn = () => {
        calls++;
        return Promise.reject(new Error('JSON parse failed'));
      };

      await expect(r.execute(fn)).rejects.toThrow('JSON parse failed');
      expect(calls).toBe(1);
    });

    test('throws last error after all retries exhausted', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      r._sleep = () => Promise.resolve();

      const fn = () => {
        const err = new Error('Rate limited');
        err.status = 429;
        return Promise.reject(err);
      };

      await expect(r.execute(fn)).rejects.toThrow('Rate limited');
    });
  });

  describe('circuit breaker', () => {
    test('trips after threshold consecutive failures', async () => {
      const r = new Resilience({ maxRetries: 0, circuitBreakerThreshold: 3, timeout: 0 });

      const fail = () => {
        const err = new Error('fail');
        err.status = 400; // non-retryable, so recordFailure immediately
        return Promise.reject(err);
      };

      // 3 failures should trip the breaker
      await expect(r.execute(fail)).rejects.toThrow();
      expect(r.circuitBreaker.failures).toBe(1);

      await expect(r.execute(fail)).rejects.toThrow();
      expect(r.circuitBreaker.failures).toBe(2);

      await expect(r.execute(fail)).rejects.toThrow();
      expect(r.circuitBreaker.failures).toBe(3);
      expect(r.isTripped()).toBe(true);
    });

    test('throws CircuitBreakerError when tripped', async () => {
      const r = new Resilience({
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 60000,
        timeout: 0,
        maxRetries: 0
      });

      // Trip it
      const fail = () => {
        const err = new Error('fail');
        err.status = 400;
        return Promise.reject(err);
      };
      await expect(r.execute(fail)).rejects.toThrow();
      expect(r.isTripped()).toBe(true);

      // Next call should throw CircuitBreakerError immediately
      await expect(r.execute(() => Promise.resolve('ok'))).rejects.toThrow(CircuitBreakerError);
    });

    test('increments totalSkipped when tripped', async () => {
      const r = new Resilience({
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 60000,
        timeout: 0,
        maxRetries: 0
      });

      // Trip it
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now();
      r.circuitBreaker.failures = 1;

      try {
        await r.execute(() => Promise.resolve());
      } catch {}
      try {
        await r.execute(() => Promise.resolve());
      } catch {}

      expect(r.circuitBreaker.totalSkipped).toBe(2);
    });

    test('half-open: allows one attempt after resetAfterMs', async () => {
      const r = new Resilience({
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 100,
        timeout: 0,
        maxRetries: 0
      });

      // Trip it
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now() - 200; // 200ms ago, > resetAfterMs
      r.circuitBreaker.failures = 1;

      // Should allow through (half-open) and succeed
      const result = await r.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(r.isTripped()).toBe(false);
      expect(r.circuitBreaker.failures).toBe(0);
    });

    test('half-open: re-trips on failure', async () => {
      const r = new Resilience({
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 100,
        timeout: 0,
        maxRetries: 0
      });

      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now() - 200;
      r.circuitBreaker.failures = 1;

      const fail = () => {
        const err = new Error('still broken');
        err.status = 400;
        return Promise.reject(err);
      };

      await expect(r.execute(fail)).rejects.toThrow('still broken');
      expect(r.isTripped()).toBe(true);
    });
  });

  describe('timeout', () => {
    test('times out slow functions', async () => {
      const r = new Resilience({ timeout: 50, maxRetries: 0 });

      const slow = () => new Promise(resolve => setTimeout(() => resolve('late'), 500));

      await expect(r.execute(slow)).rejects.toThrow('timed out');
    });

    test('does not time out fast functions', async () => {
      const r = new Resilience({ timeout: 5000, maxRetries: 0 });
      const result = await r.execute(() => Promise.resolve('fast'));
      expect(result).toBe('fast');
    });

    test('no timeout when timeout is 0', async () => {
      const r = new Resilience({ timeout: 0, maxRetries: 0 });
      const result = await r.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });
  });

  describe('backoff', () => {
    test('increases delay exponentially', () => {
      const r = new Resilience();
      // Stub Math.random for deterministic jitter
      const origRandom = Math.random;
      Math.random = () => 0; // zero jitter

      expect(r._backoffDelay(0)).toBe(1000); // 1000 * 2^0
      expect(r._backoffDelay(1)).toBe(2000); // 1000 * 2^1
      expect(r._backoffDelay(2)).toBe(4000); // 1000 * 2^2
      expect(r._backoffDelay(3)).toBe(8000); // 1000 * 2^3

      Math.random = origRandom;
    });

    test('caps at 10000ms', () => {
      const r = new Resilience();
      const origRandom = Math.random;
      Math.random = () => 0;

      expect(r._backoffDelay(4)).toBe(10000); // min(16000, 10000)
      expect(r._backoffDelay(10)).toBe(10000);

      Math.random = origRandom;
    });

    test('adds jitter', () => {
      const r = new Resilience();
      const origRandom = Math.random;
      Math.random = () => 1; // max jitter = 500

      expect(r._backoffDelay(0)).toBe(1500); // 1000 + 500

      Math.random = origRandom;
    });
  });

  describe('stats', () => {
    test('getStats returns current state', () => {
      const r = new Resilience();
      const stats = r.getStats();
      expect(stats).toEqual({
        failures: 0,
        tripped: false,
        totalSkipped: 0,
        tripTime: null
      });
    });

    test('getStats reflects failures', () => {
      const r = new Resilience();
      r.recordFailure();
      r.recordFailure();
      const stats = r.getStats();
      expect(stats.failures).toBe(2);
      expect(stats.tripped).toBe(false);
    });
  });

  describe('manual control', () => {
    test('reset clears state', () => {
      const r = new Resilience();
      r.circuitBreaker.failures = 10;
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now();

      r.reset();
      expect(r.circuitBreaker.failures).toBe(0);
      expect(r.circuitBreaker.tripped).toBe(false);
      expect(r.circuitBreaker.tripTime).toBeNull();
    });

    test('recordSuccess resets failure count and untrips', () => {
      const r = new Resilience();
      r.circuitBreaker.failures = 3;
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now();

      r.recordSuccess();
      expect(r.circuitBreaker.failures).toBe(0);
      expect(r.circuitBreaker.tripped).toBe(false);
    });
  });

  describe('_isRetryable', () => {
    test('retryable: status 429, 503, 529', () => {
      const r = new Resilience();
      expect(r._isRetryable({ status: 429 })).toBe(true);
      expect(r._isRetryable({ status: 503 })).toBe(true);
      expect(r._isRetryable({ status: 529 })).toBe(true);
    });

    test('retryable: network codes', () => {
      const r = new Resilience();
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']) {
        expect(r._isRetryable({ code })).toBe(true);
      }
    });

    test('retryable: overloaded message', () => {
      const r = new Resilience();
      expect(r._isRetryable({ message: 'API is overloaded' })).toBe(true);
    });

    test('non-retryable: regular errors', () => {
      const r = new Resilience();
      expect(r._isRetryable({ status: 400 })).toBe(false);
      expect(r._isRetryable({ status: 401 })).toBe(false);
      expect(r._isRetryable({ status: 404 })).toBe(false);
      expect(r._isRetryable({ message: 'Invalid JSON' })).toBe(false);
      expect(r._isRetryable({})).toBe(false);
    });

    test('retryable: nested response status', () => {
      const r = new Resilience();
      expect(r._isRetryable({ response: { status: 429 } })).toBe(true);
    });
  });
});

describe('CircuitBreakerError', () => {
  test('has correct properties', () => {
    const err = new CircuitBreakerError(5, 10);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CircuitBreakerError');
    expect(err.failures).toBe(5);
    expect(err.totalSkipped).toBe(10);
    expect(err.message).toContain('5 consecutive failures');
    expect(err.message).toContain('10 requests skipped');
  });
});
