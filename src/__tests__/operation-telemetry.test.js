const http = require('http');
const NullProtocol = require('../index');

// What an engineer reads in Activity for one operation: its model requests and
// its own final event, joined by run ID.
const clients = [];
let model;
let reply;

beforeAll(async () => {
  model = http.createServer(async (req, res) => {
    for await (const _ of req);
    const { status = 200, content } = await reply();
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'busy' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // No usage in the reply, as many local servers omit it.
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise(resolve => model.close(resolve)));
afterEach(async () => {
  for (const ai of clients.splice(0)) {
    ai.telemetry.enabled = false;
    await ai.close();
  }
});

function client(extra = {}) {
  const ai = new NullProtocol({
    agentId: 'support',
    provider: 'openai-compatible',
    baseURL: `http://127.0.0.1:${model.address().port}/v1`,
    model: 'qwen2.5:3b-instruct',
    telemetry: true,
    telemetryKey: 'test',
    telemetryEndpoint: 'https://telemetry.example.test',
    retry: { maxRetries: 0 },
    configFile: false,
    ...extra
  });
  clients.push(ai);
  return ai;
}

const rows = ai =>
  ai.telemetry.queue
    .filter(event => event.event !== 'model_usage')
    .map(event => ({ event: event.event, runId: event.runId, ...event.data }));

test('a schema mismatch after a repair shows the model of each request', async () => {
  reply = async () => ({ content: '{"orderId": "forty-two"}' });
  const ai = client();
  const result = await ai.extract('Order 42', { orderId: 'number' });
  expect(result).toMatchObject({ success: false, attempts: 2 });
  const events = rows(ai);
  expect(events).toEqual([
    expect.objectContaining({ event: 'ai_request', success: true, model: 'qwen2.5:3b-instruct' }),
    expect.objectContaining({ event: 'ai_request', success: true, model: 'qwen2.5:3b-instruct' }),
    expect.objectContaining({ event: 'extract', success: false, errorCode: 'schema_mismatch' })
  ]);
  expect(new Set(events.map(event => event.runId)).size).toBe(1);
});

test('a rate-limited request is reported as rate_limited by the request and the operation', async () => {
  reply = async () => ({ status: 429 });
  const ai = client();
  expect((await ai.extract('Order 42', { orderId: 'number' })).success).toBe(false);
  expect(rows(ai)).toEqual([
    expect.objectContaining({
      event: 'ai_request',
      success: false,
      errorCode: 'rate_limited',
      model: 'qwen2.5:3b-instruct'
    }),
    expect.objectContaining({ event: 'extract', success: false, errorCode: 'rate_limited' })
  ]);
});

test('an invalid schema is the caller input, with no model request', async () => {
  reply = async () => {
    throw new Error('the model must not be called');
  };
  const ai = client();
  expect((await ai.extract('Order 42', { orderId: 'strng' })).success).toBe(false);
  expect(rows(ai)).toEqual([
    expect.objectContaining({ event: 'extract', success: false, errorCode: 'config_error' })
  ]);
});

test('a timed-out request is reported as timeout by the request and the operation', async () => {
  reply = () => new Promise(resolve => setTimeout(() => resolve({ content: '{}' }), 500));
  const ai = client({ timeout: 50 });
  expect((await ai.extract('Order 42', { orderId: 'number' })).success).toBe(false);
  expect(rows(ai)).toEqual([
    expect.objectContaining({
      event: 'ai_request',
      success: false,
      errorCode: 'timeout',
      model: 'qwen2.5:3b-instruct'
    }),
    expect.objectContaining({ event: 'extract', success: false, errorCode: 'timeout' })
  ]);
});

test('an input longer than maxContextLength is the caller input, not a provider failure', async () => {
  let requests = 0;
  reply = async () => {
    requests++;
    return { content: '{"orderId": 42}' };
  };
  const ai = client({ maxContextLength: 20 });
  expect((await ai.extract('Order 42: '.repeat(20), { orderId: 'number' })).success).toBe(false);
  expect(requests).toBe(0);
  expect(rows(ai)).toEqual([
    expect.objectContaining({ event: 'extract', success: false, errorCode: 'config_error' })
  ]);
});

test('a guard refusal is reported as before', async () => {
  reply = async () => ({
    content: '{"action": "escalate", "reasoning": "long queue", "confidence": 0.9}'
  });
  const ai = client();
  const result = await ai.decide({ queue: 3 }, ['wait', 'escalate'], { guard: () => false });
  expect(result.errorCode).toBe('guard_rejected');
  expect(rows(ai)).toEqual([
    expect.objectContaining({ event: 'ai_request', success: true, model: 'qwen2.5:3b-instruct' }),
    expect.objectContaining({ event: 'decide', success: false, errorCode: 'guard_rejected' })
  ]);
});
