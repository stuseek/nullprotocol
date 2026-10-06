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
    test('cancellation before the provider microtask skips the request', async () => {
      const r = new Resilience();
      const controller = new global.AbortController();
      const provider = jest.fn(async () => 'late');
      const call = r.execute(provider, { signal: controller.signal });
      controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(provider).not.toHaveBeenCalled();
      expect(r.circuitBreaker.failures).toBe(0);
    });

    test('external cancellation aborts the provider and does not trip the circuit breaker', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 30000 });
      const controller = new global.AbortController();
      let started;
      const ready = new Promise(resolve => {
        started = resolve;
      });
      const call = r.execute(
        signal => {
          started(signal);
          return new Promise(() => {});
        },
        { signal: controller.signal }
      );
      const providerSignal = await ready;
      controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(providerSignal.aborted).toBe(true);
      expect(r.circuitBreaker.failures).toBe(0);
    });

    test('external cancellation stops retry backoff', async () => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      r._backoffDelay = () => 10000;
      const controller = new global.AbortController();
      let calls = 0;
      const call = r.execute(
        () => {
          calls++;
          throw Object.assign(new Error('rate limited'), { status: 429 });
        },
        { signal: controller.signal }
      );
      await new Promise(resolve => global.setImmediate(resolve));
      controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toBe(1);
      expect(r.circuitBreaker.failures).toBe(0);
    });

    test.each([
      ['429', { status: 429 }],
      ['503', { status: 503 }],
      ['529 (Anthropic overloaded)', { status: 529 }],
      ['ECONNRESET', { code: 'ECONNRESET' }],
      ['ETIMEDOUT', { code: 'ETIMEDOUT' }],
      ['an "overloaded" message', { message: 'API is overloaded' }]
    ])('retries on %s', async (_, fields) => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      r._sleep = () => Promise.resolve();
      let calls = 0;
      const fn = () => {
        calls++;
        if (calls < 3) return Promise.reject(Object.assign(new Error('Failed'), fields));
        return Promise.resolve('ok');
      };
      await expect(r.execute(fn)).resolves.toBe('ok');
      expect(calls).toBe(3);
    });

    test.each([
      ['400 Bad Request', { status: 400 }],
      ['401 Unauthorized', { status: 401 }],
      ['a generic error', {}]
    ])('does not retry on %s', async (_, fields) => {
      const r = new Resilience({ maxRetries: 2, timeout: 0 });
      r._sleep = () => Promise.resolve();
      let calls = 0;
      const fn = () => {
        calls++;
        return Promise.reject(Object.assign(new Error('Failed'), fields));
      };
      await expect(r.execute(fn)).rejects.toThrow('Failed');
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
        err.status = 500;
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
        err.status = 500;
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
        err.status = 500;
        return Promise.reject(err);
      };

      await expect(r.execute(fail)).rejects.toThrow('still broken');
      expect(r.isTripped()).toBe(true);
    });

    test('after the cooldown one failure trips it again and a success closes it', async () => {
      const r = new Resilience({ circuitBreakerThreshold: 3, maxRetries: 0, timeout: 0 });
      const down = () => Promise.reject(Object.assign(new Error('down'), { status: 503 }));
      for (let i = 0; i < 3; i++) await expect(r.execute(down)).rejects.toThrow('down');
      expect(r.isTripped()).toBe(true);

      r.circuitBreaker.tripTime = Date.now() - 61000;
      await expect(r.execute(down)).rejects.toThrow('down');
      expect(r.isTripped()).toBe(true);
      await expect(r.execute(down)).rejects.toThrow(CircuitBreakerError);

      r.circuitBreaker.tripTime = Date.now() - 61000;
      await expect(r.execute(() => Promise.resolve('up'))).resolves.toBe('up');
      expect(r.circuitBreaker.failures).toBe(0);
      await expect(r.execute(down)).rejects.toThrow('down');
      expect(r.isTripped()).toBe(false);
    });

    test('after the cooldown one request probes and the others are still refused', async () => {
      const r = new Resilience({ circuitBreakerThreshold: 1, maxRetries: 0, timeout: 0 });
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now() - 61000;
      let finishProbe;
      const probe = r.execute(() => new Promise(resolve => (finishProbe = resolve)));
      await expect(r.execute(() => Promise.resolve('second'))).rejects.toThrow(CircuitBreakerError);
      finishProbe('up');
      await expect(probe).resolves.toBe('up');
      expect(r.isTripped()).toBe(false);
      await expect(r.execute(() => Promise.resolve('third'))).resolves.toBe('third');
    });

    test('a request that started before a trip does not close the breaker when it succeeds', async () => {
      const r = new Resilience({ circuitBreakerThreshold: 1, maxRetries: 0, timeout: 0 });
      let finishSlow;
      const slow = r.execute(() => new Promise(resolve => (finishSlow = resolve)));
      await new Promise(resolve => setTimeout(resolve, 0));
      const down = () => Promise.reject(Object.assign(new Error('down'), { status: 503 }));
      await expect(r.execute(down)).rejects.toThrow('down');
      expect(r.isTripped()).toBe(true);
      finishSlow('late');
      await expect(slow).resolves.toBe('late');
      expect(r.isTripped()).toBe(true);
    });

    test('a cancelled probe leaves the next request to probe', async () => {
      const r = new Resilience({ circuitBreakerThreshold: 1, maxRetries: 0, timeout: 0 });
      r.circuitBreaker.tripped = true;
      r.circuitBreaker.tripTime = Date.now() - 61000;
      const controller = new AbortController();
      const cancelled = r.execute(() => new Promise(() => {}), { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toThrow('Run cancelled');
      expect(r.isTripped()).toBe(true);
      await expect(r.execute(() => Promise.resolve('up'))).resolves.toBe('up');
      expect(r.isTripped()).toBe(false);
    });

    test('client errors do not trip the shared breaker', async () => {
      const r = new Resilience({ maxRetries: 0, circuitBreakerThreshold: 2, timeout: 0 });
      const providerFailure = Object.assign(new Error('provider down'), { status: 503 });
      const clientFailure = Object.assign(new Error('bad request'), { status: 400 });
      await expect(r.execute(() => Promise.reject(providerFailure))).rejects.toThrow();
      expect(r.circuitBreaker.failures).toBe(1);
      await expect(r.execute(() => Promise.reject(clientFailure))).rejects.toThrow();
      expect(r.circuitBreaker.failures).toBe(1);
      await expect(r.execute(() => Promise.reject(providerFailure))).rejects.toThrow();
      expect(r.isTripped()).toBe(true);
    });

    test('OpenAI connection errors count toward the breaker', async () => {
      const { APIConnectionTimeoutError } = require('openai');
      const r = new Resilience({ maxRetries: 0, circuitBreakerThreshold: 2, timeout: 0 });
      const connectionError = new APIConnectionTimeoutError();
      await expect(r.execute(() => Promise.reject(connectionError))).rejects.toThrow();
      await expect(r.execute(() => Promise.reject(connectionError))).rejects.toThrow();
      expect(r.isTripped()).toBe(true);
    });

    test('Anthropic connection errors count toward the breaker', async () => {
      const { APIConnectionError } = require('@anthropic-ai/sdk');
      const r = new Resilience({ maxRetries: 0, circuitBreakerThreshold: 1, timeout: 0 });
      await expect(r.execute(() => Promise.reject(new APIConnectionError({})))).rejects.toThrow();
      expect(r.isTripped()).toBe(true);
    });
  });

  describe('timeout', () => {
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
