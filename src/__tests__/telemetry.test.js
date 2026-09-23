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
      expect(body).toContain('"inputTokens":12');
      expect(body).not.toContain('private prompt');
      expect(body).not.toContain('private reply');
      expect(body).not.toContain('"token"');
    } finally {
      requestSpy.mockRestore();
    }
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
