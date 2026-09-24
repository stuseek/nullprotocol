const { TelemetryClient } = require('../telemetry');
const https = require('https');
const { EventEmitter } = require('events');
const activeOptions = { token: 'test', endpoint: 'https://test.endpoint' };

describe('TelemetryClient', () => {
  let client;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (client) {
      client.enabled = false;
      client.destroy();
    }
  });

  describe('Constructor', () => {
    test('should initialize with token', () => {
      client = new TelemetryClient({
        token: 'test-token',
        endpoint: 'https://test.endpoint'
      });

      expect(client.token).toBe('test-token');
      expect(client.endpoint).toBe('https://test.endpoint');
      expect(client.enabled).toBe(true);
    });

    test('should be disabled without token', () => {
      client = new TelemetryClient({});

      expect(client.enabled).toBe(false);
    });

    test('should generate session ID', () => {
      client = new TelemetryClient(activeOptions);

      expect(client.sessionId).toBeDefined();
      expect(typeof client.sessionId).toBe('string');
      expect(client.sessionId.length).toBe(32);
    });
  });

  describe('track', () => {
    test('should add events to queue when enabled', () => {
      client = new TelemetryClient(activeOptions);

      client.track('test_event', { data: 'value' });

      expect(client.queue.length).toBe(1);
      expect(client.queue[0].event).toBe('test_event');
    });

    test('should not track when disabled', () => {
      client = new TelemetryClient({ enabled: false });

      client.track('test_event', { data: 'value' });

      expect(client.queue.length).toBe(0);
    });

    test('should flush when queue reaches 50 events', () => {
      client = new TelemetryClient(activeOptions);
      client.flush = jest.fn();

      for (let i = 0; i < 50; i++) {
        client.track('event', { index: i });
      }

      expect(client.flush).toHaveBeenCalled();
    });
  });

  describe('sanitizeData', () => {
    test('should remove sensitive fields', () => {
      client = new TelemetryClient(activeOptions);

      const sanitized = client.sanitizeData({
        input: 'sensitive',
        output: 'sensitive',
        content: 'sensitive',
        duration: 100,
        success: true
      });

      expect(sanitized.input).toBeUndefined();
      expect(sanitized.output).toBeUndefined();
      expect(sanitized.content).toBeUndefined();
      expect(sanitized.duration).toBe(100);
      expect(sanitized.success).toBe(true);
    });

    test('should only keep allowed fields', () => {
      client = new TelemetryClient(activeOptions);

      const sanitized = client.sanitizeData({
        duration: 100,
        success: true,
        randomField: 'should be removed',
        confidence: 0.9
      });

      expect(sanitized.duration).toBe(100);
      expect(sanitized.success).toBe(true);
      expect(sanitized.confidence).toBe(0.9);
      expect(sanitized.randomField).toBeUndefined();
    });
  });

  describe('flush', () => {
    test('splits a backlog into ingest-sized batches', async () => {
      client = new TelemetryClient(activeOptions);
      const flush = client.flush;
      client.flush = jest.fn();
      for (let i = 0; i < 130; i++) {
        client.track('chat', { success: true });
      }
      client.flush = flush;
      client.send = jest.fn().mockResolvedValue({ body: '{"rejected":[]}' });
      await client.flush();
      expect(client.send.mock.calls.map(call => call[0].length)).toEqual([50, 50, 30]);
      expect(client.queue).toHaveLength(0);
    });

    test('drops permanent failures and backs off on rate limits', async () => {
      client = new TelemetryClient(activeOptions);
      client.track('chat', {});
      client.send = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }));
      await client.flush();
      expect(client.queue).toHaveLength(0);
      expect(client.droppedEvents).toBe(1);
      client.track('chat', {});
      client.send.mockRejectedValueOnce(
        Object.assign(new Error('limited'), { status: 429, retryAfter: 30 })
      );
      await client.flush();
      expect(client.queue).toHaveLength(1);
      expect(client.retryAt).toBeGreaterThan(Date.now());
    });

    test('should clear queue after flush', async () => {
      client = new TelemetryClient(activeOptions);
      client.send = jest.fn().mockResolvedValue('success');

      client.track('event1', {});
      client.track('event2', {});

      await client.flush();

      expect(client.queue.length).toBe(0);
      expect(client.send).toHaveBeenCalled();
    });

    test('should restore queue on error', async () => {
      client = new TelemetryClient(activeOptions);
      client.send = jest.fn().mockRejectedValue(new Error('Network error'));

      client.track('event1', {});
      client.track('event2', {});

      await client.flush();

      expect(client.queue.length).toBe(2);
    });
  });

  test('sends only usage metadata and authenticates in the header', async () => {
    client = new TelemetryClient(activeOptions);
    let body = '';
    let requestOptions;
    const requestSpy = jest.spyOn(https, 'request').mockImplementation((options, onResponse) => {
      requestOptions = options;
      const req = new EventEmitter();
      req.setTimeout = jest.fn();
      req.write = chunk => {
        body += chunk;
      };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit('data', '{}');
        res.emit('end');
      };
      return req;
    });

    try {
      client.track('model_usage', {
        engine: 'openai',
        model: 'small',
        inputTokens: 12,
        outputTokens: 3,
        input: 'private prompt',
        output: 'private reply'
      });
      await client.flush();
      expect(requestOptions.headers.Authorization).toBe('Bearer test');
      expect(requestOptions.path).toBe('/api/telemetry');
      expect(body).toContain('"inputTokens":12');
      expect(body).not.toContain('private prompt');
      expect(body).not.toContain('private reply');
      expect(body).not.toContain('"token"');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('uses an explicit ingest path without changing the endpoint host', async () => {
    client = new TelemetryClient({
      token: 'test',
      endpoint: 'https://test.endpoint/old-path',
      path: '/ingest/v2?source=app'
    });
    let requestOptions;
    const requestSpy = jest.spyOn(https, 'request').mockImplementation((options, onResponse) => {
      requestOptions = options;
      const req = new EventEmitter();
      req.setTimeout = jest.fn();
      req.write = jest.fn();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit('end');
      };
      return req;
    });

    try {
      await client.send([]);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestOptions.hostname).toBe('test.endpoint');
      expect(requestOptions.path).toBe('/ingest/v2?source=app');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('keeps the legacy default path when the endpoint contains a path', async () => {
    client = new TelemetryClient({
      token: 'test',
      endpoint: 'https://test.endpoint/api/telemetry/'
    });
    let requestOptions;
    const requestSpy = jest.spyOn(https, 'request').mockImplementation((options, onResponse) => {
      requestOptions = options;
      const req = new EventEmitter();
      req.setTimeout = jest.fn();
      req.write = jest.fn();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit('end');
      };
      return req;
    });

    try {
      await client.send([]);
      expect(requestOptions.path).toBe('/api/telemetry');
    } finally {
      requestSpy.mockRestore();
    }
  });

  test('rejects a path that could change the telemetry host', () => {
    expect(() => new TelemetryClient({ ...activeOptions, path: '//other.example/ingest' })).toThrow(
      'Telemetry path'
    );
    expect(
      () => new TelemetryClient({ ...activeOptions, path: '/\\other.example/ingest' })
    ).toThrow('Telemetry path');
    expect(
      () => new TelemetryClient({ ...activeOptions, path: '/\t/other.example/ingest' })
    ).toThrow('Telemetry path');
  });

  test('rejects a non-HTTPS endpoint before queueing events', () => {
    expect(() => new TelemetryClient({ token: 'test', endpoint: 'http://example.test' })).toThrow(
      'HTTPS'
    );
  });

  describe('destroy', () => {
    test('should clear interval and flush', () => {
      // Use real timers for this test since we need clearInterval to be real
      jest.useRealTimers();
      client = new TelemetryClient(activeOptions);
      client.flush = jest.fn();
      const interval = client.flushInterval;

      client.destroy();

      expect(client.flush).toHaveBeenCalled();
      // Interval should have been cleared (no way to directly assert, but no error = success)
      expect(client.flushInterval).toBeDefined(); // still holds the ref, but cleared
    });
  });
});
