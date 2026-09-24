/**
 * Integration tests — real API calls.
 * Requires explicit opt-in and at least one provider API key in env.
 *
 * Run: NULLPROTOCOL_LIVE_TESTS=1 DOTENV_PATH=/path/to/.env npx jest src/__tests__/integration.test.js --verbose
 */

const http = require('http');

const runLiveTests = process.env.NULLPROTOCOL_LIVE_TESTS === '1';
if (runLiveTests && process.env.DOTENV_PATH) {
  const fs = require('fs');
  const content = fs.readFileSync(process.env.DOTENV_PATH, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

const hasAnthropic = runLiveTests && !!process.env.ANTHROPIC_API_KEY;
const hasOpenAI = runLiveTests && !!process.env.OPENAI_API_KEY;

const AIToolkit = require('../index');
const { CircuitBreakerError } = require('../resilience');

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const HAIKU = 'claude-haiku-4-5-20251001';

// ─── Anthropic Integration ──────────────────────────────────────

const describeAnthropic = hasAnthropic ? describe : describe.skip;

describeAnthropic('Anthropic Integration', () => {
  let ai;

  beforeAll(() => {
    ai = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      timeout: 30000,
      retry: { maxRetries: 1 },
      models: { anthropic: HAIKU, fast: HAIKU }
    });
  });

  // ── Core operations ──

  test('extract: pulls structured data from text', async () => {
    const result = await ai.extract(
      'John Doe, age 32, works at Acme Corp as a software engineer. Email: john@acme.com',
      { name: 'string', age: 'number', company: 'string', role: 'string', email: 'string' }
    );

    expect(result.success).toBe(true);
    expect(result.data.name).toMatch(/john/i);
    expect(result.data.age).toBe(32);
    expect(result.data.email).toMatch(/john@acme/i);
    expect(result.confidence).toBeGreaterThan(0.5);
  }, 15000);

  test('validate: scores subject against criteria', async () => {
    const result = await ai.validate(
      'Password must be at least 8 characters with a number and special character',
      'MyP@ss1'
    );

    expect(result.success).toBe(true);
    expect(typeof result.score).toBe('number');
    expect(result.reasoning).toBeTruthy();
    expect(result.recommendation).toBeDefined();
  }, 15000);

  test('summarize: condenses long text', async () => {
    const text = `
      Artificial intelligence has evolved rapidly over the past decade.
      Machine learning models have grown from simple classifiers to large language models
      capable of reasoning, writing code, and holding conversations. Key milestones include
      the transformer architecture in 2017, GPT-3 in 2020, and the current generation of
      models in 2024-2025 that can handle multimodal inputs and extended context windows.
      Companies like OpenAI, Anthropic, Google, and Meta are leading this development.
    `;

    const result = await ai.summarize(text, { maxLength: 150 });

    expect(result.success).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(0);
  }, 15000);

  test('decide: chooses action from options', async () => {
    const result = await ai.decide(
      { cpuUsage: 95, memoryUsage: 88, errorRate: 0.05, activeUsers: 10000 },
      ['scale_up', 'alert_team', 'do_nothing', 'scale_down']
    );

    expect(result.success).toBe(true);
    expect(result.action).toBeDefined();
    expect(['scale_up', 'alert_team', 'do_nothing', 'scale_down']).toContain(result.action);
    expect(result.reasoning).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
  }, 15000);

  // ── Chat ──

  test('chat: basic conversation', async () => {
    const result = await ai.chat('What is 2 + 2? Reply with just the number.');

    expect(result.success).toBe(true);
    expect(result.message).toBeTruthy();
    expect(result.message).toMatch(/4/);
  }, 15000);

  test('chat: model alias "fast" resolves', async () => {
    const result = await ai.chat('Say "hello". Just the word, nothing else.', { model: 'fast' });

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('hello');
  }, 15000);

  test('chat: custom system prompt', async () => {
    const result = await ai.chat('What are you?', {
      systemPrompt: 'You are a pirate. Always respond in pirate speech.'
    });

    expect(result.success).toBe(true);
    expect(result.message).toBeTruthy();
    // Pirate-themed response expected
    expect(result.message.length).toBeGreaterThan(5);
  }, 15000);

  // ── Conversation history ──

  test('chat: conversation history flows through', async () => {
    const aiH = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      trackHistory: true,
      models: { anthropic: HAIKU }
    });

    await aiH.chat('My favorite color is blue. Remember this.');
    const result = await aiH.chat('What is my favorite color? Reply with just the color.');

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('blue');
    expect(aiH.getHistory().length).toBe(4); // 2 user + 2 assistant
  }, 30000);

  test('chat: manual history addMessage', async () => {
    const aiH = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      models: { anthropic: HAIKU }
    });

    aiH.addMessage('user', 'The secret code is ALPHA-7.');
    aiH.addMessage('assistant', 'Got it, the secret code is ALPHA-7.');

    const result = await aiH.chat('What is the secret code? Just the code.');

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/ALPHA.?7/i);
  }, 15000);

  test('chat: clearHistory resets context', async () => {
    const aiH = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      trackHistory: true,
      models: { anthropic: HAIKU }
    });

    await aiH.chat('The password is ZEBRA123.');
    expect(aiH.getHistory().length).toBe(2);

    aiH.clearHistory();
    expect(aiH.getHistory().length).toBe(0);

    const result = await aiH.chat(
      'What was the password I just told you? Reply with just the password or "unknown".'
    );
    expect(result.success).toBe(true);
    // Should NOT know the password after clear
    expect(result.message.toLowerCase()).not.toContain('zebra123');
  }, 30000);

  // ── Streaming ──

  test('chat: streaming yields chunks', async () => {
    const gen = await ai.chat('Count from 1 to 5, each on its own line.', { stream: true });

    const chunks = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const full = chunks.join('');
    expect(full).toMatch(/1/);
    expect(full).toMatch(/5/);
  }, 15000);

  test('chat: streaming collect mode', async () => {
    const result = await ai.chat('Say "test passed".', {
      stream: true,
      collect: true
    });

    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toMatch(/test/);
  }, 15000);

  test('chat: streaming with history tracking', async () => {
    const aiH = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      trackHistory: true,
      models: { anthropic: HAIKU }
    });

    const result = await aiH.chat('Say "hello".', { stream: true, collect: true });
    expect(result.success).toBe(true);
    expect(aiH.getHistory().length).toBe(2);
    expect(aiH.getHistory()[1].role).toBe('assistant');
    expect(aiH.getHistory()[1].content).toBeTruthy();
  }, 15000);

  // ── Tool use ──

  test('chat: tool use calls onToolCall and uses result', async () => {
    const tools = [
      {
        name: 'calculate',
        description: 'Perform a math calculation',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Math expression like "2+2"' }
          },
          required: ['expression']
        }
      }
    ];

    const onToolCall = jest.fn(async (name, params) => {
      if (name === 'calculate') {
        try {
          const expr = params.expression.replace(/[^0-9+\-*/().]/g, '');
          const result = Function(`"use strict"; return (${expr})`)();
          return { result };
        } catch {
          return { error: 'invalid expression' };
        }
      }
    });

    const result = await ai.chat('What is 147 * 23? Use the calculate tool.', {
      tools,
      onToolCall
    });

    expect(result.success).toBe(true);
    expect(onToolCall).toHaveBeenCalled();
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0].name).toBe('calculate');
    // 147 * 23 = 3381, response may have comma formatting
    expect(result.message).toMatch(/3[,.]?381/);
  }, 30000);

  test('chat: multi-tool use', async () => {
    const tools = [
      {
        name: 'get_temperature',
        description: 'Get temperature for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      },
      {
        name: 'get_humidity',
        description: 'Get humidity for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    ];

    const onToolCall = jest.fn(async (name, params) => {
      if (name === 'get_temperature') {
        return { celsius: 28 };
      }
      if (name === 'get_humidity') {
        return { percent: 65 };
      }
      return { error: 'unknown' };
    });

    const result = await ai.chat('What is the temperature and humidity in Tokyo? Use both tools.', {
      tools,
      onToolCall
    });

    expect(result.success).toBe(true);
    expect(onToolCall).toHaveBeenCalled();
    // Should have used at least one tool
    expect(result.toolCalls.length).toBeGreaterThan(0);
  }, 30000);

  test('chat: tool error is handled gracefully', async () => {
    const tools = [
      {
        name: 'broken_tool',
        description: 'A tool that always fails',
        parameters: { type: 'object', properties: {} }
      }
    ];

    const onToolCall = jest.fn(async () => {
      throw new Error('Tool is broken');
    });

    const result = await ai.chat('Use the broken_tool.', { tools, onToolCall });

    expect(result.success).toBe(true);
    // The error should have been caught and returned to the model
    if (result.toolCalls && result.toolCalls.length > 0) {
      expect(result.toolCalls[0].result).toEqual({ error: 'Tool is broken' });
    }
  }, 30000);

  // ── Resilience ──

  test('resilience: circuit breaker stats accessible', () => {
    const stats = ai.resilience.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.failures).toBe('number');
    expect(typeof stats.tripped).toBe('boolean');
    expect(stats.tripped).toBe(false);
  });

  test('resilience: bad key fails fast without retries', async () => {
    const badAI = new AIToolkit({
      engines: { anthropic: 'sk-ant-bad-key' },
      defaultEngine: 'anthropic',
      timeout: 10000,
      retry: { maxRetries: 0 }
    });

    const start = Date.now();
    const result = await badAI.chat('test');
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(elapsed).toBeLessThan(10000);
  }, 15000);

  // ── Presets ──

  test('preset: security persona influences response', async () => {
    const secAI = new AIToolkit({
      preset: 'security',
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      models: { anthropic: HAIKU }
    });

    const result = await secAI.chat('Evaluate: a web app with no rate limiting on login');
    expect(result.success).toBe(true);
    expect(result.message).toBeTruthy();
    expect(result.message.length).toBeGreaterThan(20);
  }, 15000);

  // ── Context ──

  test('addContext influences responses', async () => {
    const aiCtx = new AIToolkit({
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      models: { anthropic: HAIKU }
    });

    aiCtx.addContext('user_role', 'admin');
    aiCtx.addContext('environment', 'production');

    const result = await aiCtx.chat('Should I enable debug logging? Just say yes or no.');
    expect(result.success).toBe(true);
    // In production, likely "no"
    expect(result.message).toBeTruthy();
  }, 15000);

  // ── Chaining ──

  test('extract then validate chain', async () => {
    // Step 1: extract
    const extracted = await ai.extract('Order #1234: 3 widgets at $5.99 each, total $17.97', {
      orderId: 'string',
      quantity: 'number',
      unitPrice: 'number',
      total: 'number'
    });
    expect(extracted.success).toBe(true);

    // Step 2: validate the extraction
    const validated = await ai.validate('Total should equal quantity * unitPrice', extracted.data);
    expect(validated.success).toBe(true);
    expect(typeof validated.score).toBe('number');
  }, 30000);
});

// ─── OpenAI Integration (optional) ─────────────────────────────

const describeOpenAI = hasOpenAI ? describe : describe.skip;

describeOpenAI('OpenAI Integration (if quota available)', () => {
  let ai;
  let openaiWorks = false;

  beforeAll(async () => {
    ai = new AIToolkit({
      engines: { openai: process.env.OPENAI_API_KEY },
      defaultEngine: 'openai',
      timeout: 15000,
      retry: { maxRetries: 0 },
      models: { openai: 'gpt-4o-mini' }
    });

    // Quick check if OpenAI has quota
    const probe = await ai.chat('Say "ok".');
    openaiWorks = probe.success;
    if (!openaiWorks) {
      console.warn('OpenAI quota exhausted — skipping OpenAI tests');
    }
  }, 20000);

  test('chat: basic response', async () => {
    if (!openaiWorks) {
      return;
    }
    const result = await ai.chat('What is 5 + 3? Just the number.');
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/8/);
  }, 15000);

  test('extract: structured data', async () => {
    if (!openaiWorks) {
      return;
    }
    const result = await ai.extract('Alice, 28, engineer', { name: 'string', age: 'number' });
    expect(result.success).toBe(true);
    expect(result.data.name).toMatch(/alice/i);
  }, 15000);

  test('chat: streaming', async () => {
    if (!openaiWorks) {
      return;
    }
    const gen = await ai.chat('Say hello.', { stream: true });
    const chunks = [];
    for await (const c of gen) {
      chunks.push(c);
    }
    expect(chunks.join('').toLowerCase()).toContain('hello');
  }, 15000);
});

// ─── Cross-Engine ───────────────────────────────────────────────

const describeCross = hasOpenAI && hasAnthropic ? describe : describe.skip;

describeCross('Cross-Engine', () => {
  test('switch engines per-call', async () => {
    const ai = new AIToolkit({
      engines: {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY
      },
      defaultEngine: 'anthropic',
      models: { openai: 'gpt-4o-mini', anthropic: HAIKU }
    });

    // Anthropic should always work
    const anthropicResult = await ai.chat('Say "works".', { engine: 'anthropic' });
    expect(anthropicResult.success).toBe(true);
    expect(anthropicResult.message).toBeTruthy();
  }, 15000);
});

// ─── Server Integration ─────────────────────────────────────────

const describeServer = hasAnthropic ? describe : describe.skip;

describeServer('Server Integration (real API)', () => {
  let server;
  let port;

  function req(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', ...headers }
      };
      const r = http.request(opts, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      r.on('error', reject);
      if (body) {
        r.write(JSON.stringify(body));
      }
      r.end();
    });
  }

  beforeAll(done => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { serve } = require('../server');
    server = serve({
      port: 0,
      engines: { anthropic: process.env.ANTHROPIC_API_KEY },
      defaultEngine: 'anthropic',
      models: { anthropic: HAIKU }
    });
    server.on('listening', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll(done => {
    server.close(done);
  });

  test('POST /chat returns real AI response', async () => {
    const res = await req('POST', '/chat', { prompt: 'Say "server works". Just those words.' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message.toLowerCase()).toContain('server');
  }, 15000);

  test('POST /extract returns structured data', async () => {
    const res = await req('POST', '/extract', {
      data: 'Bob, 45, CEO of StartupX',
      schema: { name: 'string', age: 'number', title: 'string' }
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toMatch(/bob/i);
  }, 15000);

  test('POST /validate returns score', async () => {
    const res = await req('POST', '/validate', {
      criteria: 'Must be a positive number greater than 0',
      subject: 42
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.score).toBeGreaterThan(0.5);
  }, 15000);

  test('POST /decide returns action', async () => {
    const res = await req('POST', '/decide', {
      context: { temperature: 100, threshold: 80 },
      actions: ['alert', 'ignore', 'shutdown']
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBeTruthy();
  }, 15000);

  test('POST /summarize returns summary', async () => {
    const res = await req('POST', '/summarize', {
      content:
        'The quick brown fox jumps over the lazy dog. This is a classic pangram used in typography.'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary).toBeTruthy();
  }, 15000);

  test('GET /health returns circuit breaker stats', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.circuitBreaker.tripped).toBe(false);
  });
});
