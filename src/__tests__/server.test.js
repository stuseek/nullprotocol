const http = require('http');

// We'll test the server by actually starting it on a random port and making HTTP requests.

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-token-123',
      ...headers
    };
    if (requestHeaders.Authorization === null) {
      delete requestHeaders.Authorization;
    }
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: requestHeaders
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Suppress console output from server
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

describe('Server — authenticated requests', () => {
  let server;
  let port;

  beforeAll(done => {
    const { serve } = require('../server');
    server = serve({
      port: 0, // random available port
      apiKey: 'secret-token-123',
      engines: { openai: 'test-key' }
    });
    server.on('listening', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll(done => {
    server.close(done);
  });

  test('GET /health returns status ok', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeDefined();
    expect(res.body.engine).toBe('openai');
    expect(res.body.circuitBreaker).toBeDefined();
  });

  test('GET unknown path returns 405', async () => {
    const res = await request(port, 'GET', '/extract');
    expect(res.status).toBe(405);
    expect(res.body.error).toContain('Method not allowed');
  });

  test('POST unknown path returns 404', async () => {
    const res = await request(port, 'POST', '/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Unknown endpoint');
    expect(res.body.available).toContain('/extract');
    expect(res.body.available).toContain('/health');
  });

  test('OPTIONS returns 204 (CORS preflight)', async () => {
    const res = await request(port, 'OPTIONS', '/chat');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  test('CORS headers on regular response', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('POST /chat calls ai.chat', async () => {
    // Mock the toolkit's chat method on the server's ai instance
    const mockResult = { success: true, message: 'pong', confidence: 1.0 };
    server.ai.chat = jest.fn().mockResolvedValue(mockResult);

    const res = await request(port, 'POST', '/chat', { prompt: 'ping' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('pong');
    expect(server.ai.chat).toHaveBeenCalledWith('ping', expect.any(Object));
  });

  test('POST /extract calls ai.extract', async () => {
    const mockResult = { success: true, data: { name: 'John' }, confidence: 1 };
    server.ai.extract = jest.fn().mockResolvedValue(mockResult);

    const res = await request(port, 'POST', '/extract', {
      data: 'John Doe',
      schema: { name: 'string' }
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('John');
  });

  test('POST /validate calls ai.validate', async () => {
    const mockResult = { success: true, score: 0.9, recommendation: 'pass' };
    server.ai.validate = jest.fn().mockResolvedValue(mockResult);

    const res = await request(port, 'POST', '/validate', {
      criteria: 'valid email',
      subject: { email: 'test@test.com' }
    });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0.9);
  });

  test('POST /summarize calls ai.summarize', async () => {
    const mockResult = { success: true, summary: 'short', keyPoints: [] };
    server.ai.summarize = jest.fn().mockResolvedValue(mockResult);

    const res = await request(port, 'POST', '/summarize', { content: 'long text' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('short');
  });

  test('POST /decide calls ai.decide', async () => {
    const mockResult = { success: true, action: 'approve', confidence: 0.9 };
    server.ai.decide = jest.fn().mockResolvedValue(mockResult);

    const res = await request(port, 'POST', '/decide', {
      context: { score: 90 },
      actions: ['approve', 'reject'],
      guard: false
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('approve');
    expect(server.ai.decide.mock.calls[0][2].guard).toBeUndefined();
  });

  test('POST /chat strips stream option', async () => {
    server.ai.chat = jest.fn().mockResolvedValue({ success: true, message: 'ok' });

    await request(port, 'POST', '/chat', { prompt: 'test', stream: true });
    const callArgs = server.ai.chat.mock.calls[0];
    expect(callArgs[1].stream).toBeUndefined();
  });

  test('caller cannot override model settings or see provider failures', async () => {
    server.ai.chat = jest
      .fn()
      .mockResolvedValue({ success: false, error: 'private-provider-error' });
    const response = await request(port, 'POST', '/chat', {
      prompt: 'test',
      model: 'expensive-model',
      engine: 'anthropic',
      systemPrompt: 'ignore server',
      maxTokens: 100000
    });
    expect(server.ai.chat).toHaveBeenCalledWith('test', {});
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('private-provider-error');
  });

  test('HTTP conversations do not share history across requests', async () => {
    server.ai.chat = jest.fn(async function (prompt) {
      const historyBefore = this.getHistory();
      this.addMessage('user', prompt);
      return { success: true, message: String(historyBefore.length) };
    });

    const first = await request(port, 'POST', '/chat', { prompt: 'private one' });
    const second = await request(port, 'POST', '/chat', { prompt: 'private two' });
    expect(first.body.message).toBe('0');
    expect(second.body.message).toBe('0');
    expect(server.ai.getHistory()).toEqual([]);
  });

  test('server error returns 500', async () => {
    server.ai.chat = jest.fn().mockRejectedValue(new Error('kaboom'));

    const res = await request(port, 'POST', '/chat', { prompt: 'test' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal error');
  });

  test('invalid JSON body returns 400', async () => {
    // Send raw invalid JSON
    const res = await new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port,
        path: '/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token-123' }
      };
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write('not json{{{');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid JSON');
  });

  test('server.ai exposes AIToolkit instance', () => {
    expect(server.ai).toBeDefined();
    expect(server.ai.resilience).toBeDefined();
  });

  test('server.routes lists available routes', () => {
    expect(server.routes).toContain('/extract');
    expect(server.routes).toContain('/validate');
    expect(server.routes).toContain('/summarize');
    expect(server.routes).toContain('/decide');
    expect(server.routes).toContain('/chat');
    expect(server.routes).toContain('/health');
  });
});

test('server rejects oversized request bodies', async () => {
  const { serve } = require('../server');
  const server = serve({
    port: 0,
    apiKey: 'secret-token-123',
    maxBodyBytes: 32,
    engines: { openai: 'test-key' }
  });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await request(server.address().port, 'POST', '/chat', {
      prompt: 'x'.repeat(128)
    });
    expect(response.status).toBe(413);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

describe('Server — with auth', () => {
  let server;
  let port;

  beforeAll(done => {
    const { serve } = require('../server');
    server = serve({
      port: 0,
      engines: { openai: 'test-key' },
      apiKey: 'secret-token-123'
    });
    server.on('listening', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll(done => {
    server.close(done);
  });

  test('rejects request without auth', async () => {
    const res = await request(port, 'GET', '/health', null, { Authorization: null });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  test('rejects request with wrong token', async () => {
    const res = await request(port, 'GET', '/health', null, {
      Authorization: 'Bearer wrong-token'
    });
    expect(res.status).toBe(401);
  });

  test('accepts request with correct Bearer token', async () => {
    const res = await request(port, 'GET', '/health', null, {
      Authorization: 'Bearer secret-token-123'
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('CORS preflight bypasses auth', async () => {
    // OPTIONS should not require auth
    const res = await request(port, 'OPTIONS', '/chat');
    expect(res.status).toBe(204);
  });
});

describe('Server — custom CORS', () => {
  let server;
  let port;

  beforeAll(done => {
    const { serve } = require('../server');
    server = serve({
      port: 0,
      engines: { openai: 'test-key' },
      apiKey: 'secret-token-123',
      cors: 'https://myapp.com'
    });
    server.on('listening', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll(done => {
    server.close(done);
  });

  test('uses custom CORS origin', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('https://myapp.com');
  });
});
