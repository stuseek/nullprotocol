const { NullProtocol } = require('..');
const { createModel } = require('../runtime');

const response = body => new global.Response(JSON.stringify(body), { status: 200 });
const completion = {
  choices: [{ message: { content: '{"days":30}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 6 }
};

test('a hosted agent needs its Space key', async () => {
  await expect(
    NullProtocol.create({ provider: 'nullprotocol', model: 'ministral-14b-2512' })
  ).rejects.toMatchObject({ code: 'key_required' });
});

test('a saved hosted agent uses the same Space key for settings, model and history', async () => {
  const original = global.fetch;
  const seen = [];
  const key = 'np_space_test';
  const settings = {
    agentId: 'support',
    provider: 'nullprotocol',
    model: 'ministral-14b-2512',
    instructions: '',
    disabledActions: []
  };
  global.fetch = async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith('/settings')) return response({ agent: settings });
    if (url.endsWith('/turn')) {
      return response({ agent: settings, entries: [], notes: [], missing: [], documents: [] });
    }
    if (url.endsWith('/chat/completions')) return response(completion);
    if (url.endsWith('/operations')) return response({ recorded: true });
    throw new Error('Unexpected route');
  };
  try {
    const agent = await NullProtocol.load({
      key,
      endpoint: 'https://platform.example',
      agentId: 'support'
    });
    const result = await agent.extract('Returns within 30 days.', { days: 'number' });
    expect(result.success).toBe(true);
    expect(result.data.days).toBe(30);
    expect(result.historyError).toBeUndefined();
    expect(seen.every(call => call.options.headers.Authorization === `Bearer ${key}`)).toBe(true);
    const model = seen.find(call => call.url.endsWith('/chat/completions'));
    expect(model.url).toBe('https://platform.example/v1/chat/completions');
    expect(model.options.headers['X-NullProtocol-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(seen.at(-1).options.body).provider).toBe('nullprotocol');
  } finally {
    global.fetch = original;
  }
});

test('a retry keeps the hosted request ID and cannot dispatch a second paid call', async () => {
  const ids = [];
  const model = createModel(
    { provider: 'nullprotocol', model: 'ministral-14b-2512', apiKey: 'space-key' },
    { retry: { maxRetries: 1 } },
    async (_url, options) => {
      ids.push(options.headers['X-NullProtocol-Request-Id']);
      if (ids.length === 1) throw new TypeError('fetch failed');
      return response(completion);
    }
  );
  const reply = await model.complete('Extract days.', [], 10000, { sent() {}, answered() {} });
  expect(reply.text).toBe('{"days":30}');
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(1);
});

test('hosted credit refusal is actionable and is not retried', async () => {
  let calls = 0;
  const model = createModel(
    { provider: 'nullprotocol', model: 'ministral-14b-2512', apiKey: 'space-key' },
    {},
    async () => {
      calls++;
      return new global.Response(JSON.stringify({ error: { code: 'spend_cap_reached' } }), {
        status: 402
      });
    }
  );
  await expect(
    model.complete('hello', [], 10000, { sent() {}, answered() {} })
  ).rejects.toMatchObject({ code: 'spend_cap_reached' });
  expect(calls).toBe(1);
});
