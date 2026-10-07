const http = require('http');
const { NullProtocol } = require('..');

// A model server that answers with the next scripted reply and keeps what it was sent.
let server;
let baseURL;
let replies;
let requests;
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      requests.push({ ...JSON.parse(body), bytes: Buffer.byteLength(body) });
      const reply = replies.shift();
      response.setHeader('Content-Type', 'application/json');
      if (reply.status) {
        response.statusCode = reply.status;
        return response.end('{}');
      }
      const { content = reply, usage = { prompt_tokens: 10, completion_tokens: 5 } } = reply;
      return response.end(
        JSON.stringify({
          choices: [
            {
              message: { content: typeof content === 'string' ? content : JSON.stringify(content) }
            }
          ],
          ...(usage ? { usage } : {})
        })
      );
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  replies = [];
  requests = [];
});

const create = options =>
  NullProtocol.create({ provider: 'openai-compatible', model: 'test', baseURL, ...options });
const systemOf = index => requests[index].messages[0].content;

test('without a key the Agent lives in the process and only the model is called', async () => {
  const fetched = jest.spyOn(globalThis, 'fetch');
  const agent = await create({ instructions: 'You work for Mugs & Co.' });
  expect(agent.agentId).toMatch(/^agent-/);
  await agent.space.set('brand', 'Mugs & Co');
  await agent.space.set('region', 'World');
  await agent.context.set('region', { region: 'EU' });
  await agent.context.set('policy', 'Returns within 45 days.', { inclusion: 'selected' });
  await agent.memory.add('The customer is Dana.');

  replies.push({ days: 45 }, { days: 45 });
  expect(await agent.extract('How long?', { days: 'number' })).toMatchObject({
    success: true,
    data: { days: 45 },
    usage: { inputTokens: 10, outputTokens: 5 }
  });
  // An entry sent with every operation and the notes are there; a selected entry only when named.
  expect(systemOf(0)).toContain('You work for Mugs & Co.');
  expect(systemOf(0)).toContain('{"region":"EU"}');
  expect(systemOf(0)).toContain('brand:\nMugs & Co');
  expect(systemOf(0)).not.toContain('World');
  expect(systemOf(0)).toContain('The customer is Dana.');
  expect(systemOf(0)).not.toContain('45 days');
  await agent.extract('How long?', { days: 'number' }, { contextKeys: ['policy'] });
  expect(systemOf(1)).toContain('Returns within 45 days.');

  expect(await agent.extract('x', { days: 'number' }, { contextKeys: ['nope'] })).toMatchObject({
    success: false,
    errorCode: 'context_key_not_found'
  });
  expect(fetched.mock.calls.every(([url]) => url.startsWith(baseURL))).toBe(true);
  expect(fetched).toHaveBeenCalledTimes(2);
  fetched.mockRestore();

  await expect(NullProtocol.load({ agentId: agent.agentId })).rejects.toMatchObject({
    code: 'key_required'
  });
});

test('each operation checks the reply and lets the model repair it once', async () => {
  const agent = await create();
  // The input is taken when the operation starts; a later change by the caller is not sent.
  const invoice = { amount: 200 };
  replies.push({ amount: 200 });
  const pending = agent.extract(invoice, { amount: 'number' });
  invoice.amount = 999;
  await pending;
  expect(requests[0].messages[1].content).toContain('"amount":200');
  requests.length = 0;
  replies.push({ days: 'many' }, { days: 30 });
  expect(await agent.extract('How long?', { days: 'number' })).toMatchObject({
    data: { days: 30 },
    attempts: 2,
    repaired: true
  });
  expect(requests[1].messages.at(-1).content).toMatch(/does not match the schema/);

  // A schema for a list takes a list, also of one item.
  const lines = {
    type: 'array',
    items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] }
  };
  replies.push([{ sku: 'mug' }]);
  expect(await agent.extract('One mug', lines)).toMatchObject({
    success: true,
    data: [{ sku: 'mug' }],
    attempts: 1
  });

  replies.push('not json', 'still not json');
  expect(await agent.extract('How long?', { days: 'number' })).toMatchObject({
    success: false,
    data: null,
    errorCode: 'invalid_reply'
  });

  replies.push({ summary: 'Paid on Monday.', keyPoints: ['paid'] });
  expect(await agent.summarize('The invoice was paid on Monday.', { maxLength: 40 })).toMatchObject(
    {
      success: true,
      summary: 'Paid on Monday.'
    }
  );
  // A score that is not a number is no score, however the model spells it.
  replies.push(
    { score: '0.9', reasoning: 'Clear.', recommendation: 'pass' },
    { score: null, reasoning: 'Clear.', recommendation: 'pass' }
  );
  expect(await agent.validate('Is it polite?', 'Thank you!')).toMatchObject({
    success: false,
    errorCode: 'invalid_reply'
  });
  replies.push({ score: 0.9, reasoning: 'Clear.', recommendation: 'pass' });
  expect(await agent.validate('Is it polite?', 'Thank you!')).toMatchObject({
    success: true,
    recommendation: 'pass'
  });
  replies.push({ action: 'delete', reasoning: 'x' }, { action: 'escalate', reasoning: 'Angry.' });
  expect(await agent.decide('Angry customer', ['reply', 'escalate'])).toMatchObject({
    success: true,
    action: 'escalate',
    attempts: 2
  });
});

test('a request over the budget and a model without credentials fail before any call', async () => {
  const tight = await create({ maxPromptBytes: 200 });
  await tight.context.set('manual', 'x'.repeat(300));
  expect(await tight.extract('x', { days: 'number' })).toMatchObject({
    success: false,
    errorCode: 'model_context_too_large'
  });
  const agent = await create();
  await agent.update({ provider: 'anthropic', model: 'claude' });
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  expect(await agent.extract('x', { days: 'number' })).toMatchObject({
    success: false,
    errorCode: 'model_unavailable'
  });
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  expect(requests).toHaveLength(0);
});

test('execute runs the handler of a decision once, after the schema and the guard', async () => {
  const agent = await create();
  const refund = jest.fn(async ({ orderId }) => ({ refunded: orderId }));
  const guarded = [];
  agent.registerAction('refund', refund, {
    input: { type: 'object', properties: { orderId: { type: 'number' } }, required: ['orderId'] },
    guard: ({ orderId }, decision) => {
      guarded.push(decision.action);
      if (orderId === 99) throw new Error('lookup failed');
      return orderId !== 13;
    }
  });
  const decide = parameters => {
    replies.push({ action: 'refund', reasoning: 'Asked.', parameters });
    return agent.decide('Refund please', ['refund', 'chat']);
  };

  expect(await agent.execute(await decide({ orderId: 13 }))).toMatchObject({
    outcome: 'refused',
    errorCode: 'guard_rejected'
  });
  expect(await agent.execute(await decide({ orderId: 99 }))).toMatchObject({
    outcome: 'refused',
    errorCode: 'guard_error'
  });
  expect(await agent.execute(await decide({ orderId: 'x' }))).toMatchObject({
    outcome: 'refused',
    errorCode: 'invalid_parameters'
  });
  expect(
    await agent.execute({ success: true, action: 'refund', parameters: { orderId: 1 } })
  ).toMatchObject({
    errorCode: 'not_a_decision'
  });
  expect(refund).not.toHaveBeenCalled();

  // What runs is the decision as it was made, on the settings it was made with.
  const decision = await decide({ orderId: 42 });
  decision.parameters.orderId = 13;
  decision.action = 'chat';
  await agent.update({ model: 'another' });
  const runs = await Promise.all([agent.execute(decision), agent.execute(decision)]);
  expect(runs.map(run => run.errorCode ?? run.outcome)).toEqual(['completed', 'already_executed']);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund.mock.calls[0][0]).toEqual({ orderId: 42 });
  expect(guarded.at(-1)).toBe('refund');

  await agent.update({ paused: true });
  expect(await agent.extract('x', { days: 'number' })).toMatchObject({ errorCode: 'agent_paused' });
  await agent.update({ paused: false });
  const late = await decide({ orderId: 7 });
  await agent.update({ paused: true });
  expect(await agent.execute(late)).toMatchObject({
    outcome: 'refused',
    errorCode: 'agent_paused'
  });

  // A disabled action is not offered to a decision, and one decided earlier does not run.
  await agent.update({ paused: false });
  const earlier = await decide({ orderId: 8 });
  await agent.update({ disabledActions: ['refund'] });
  expect(await agent.execute(earlier)).toMatchObject({
    outcome: 'refused',
    errorCode: 'action_disabled'
  });
  replies.push({ action: 'chat', reasoning: 'Only chat is left.' });
  await agent.decide('Refund please', ['refund', 'chat']);
  expect(requests.at(-1).messages[1].content).toContain('Available actions: ["chat"]');
  expect(await agent.decide('Refund please', ['refund'])).toMatchObject({
    errorCode: 'action_disabled'
  });
  expect(refund).toHaveBeenCalledTimes(1);
});

test('chat is an action a decision chooses, answered by the same model', async () => {
  const agent = await create({ instructions: 'Be kind.' });
  replies.push({
    action: 'chat',
    reasoning: 'A question.',
    parameters: { message: 'What is your name?' }
  });
  const decision = await agent.decide('What is your name?', ['chat', 'escalate']);
  replies.push('I am the Mugs & Co assistant.');
  expect(await agent.execute(decision)).toMatchObject({
    outcome: 'completed',
    result: 'I am the Mugs & Co assistant.'
  });
  expect(systemOf(1)).toContain('Be kind.');
  expect(agent.chat).toBeUndefined();
});

test('a saved Agent records what really went to the model', async () => {
  // A Space that serves one Agent and keeps what the SDK reports.
  const recorded = [];
  const space = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      if (request.method === 'POST') recorded.push(JSON.parse(body));
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          agent: { provider: 'openai-compatible', model: 'test', instructions: '', revision: 3 },
          entries: [{ key: 'policy', value: 'Returns within 45 days.', version: 'v1' }],
          notes: [],
          missing: []
        })
      );
    });
  });
  await new Promise(resolve => space.listen(0, '127.0.0.1', resolve));
  const load = maxPromptBytes =>
    NullProtocol.load({
      key: 'np_space_test',
      endpoint: `http://127.0.0.1:${space.address().port}`,
      agentId: 'support',
      credentials: { 'openai-compatible': { baseURL } },
      maxPromptBytes
    });

  // A retried request is two requests; a provider that does not count tokens reports none.
  replies.push({ status: 503 }, { content: { days: 45 }, usage: null });
  const result = await (await load(4096)).extract('How long?', { days: 'number' });
  expect(result).toMatchObject({ success: true, data: { days: 45 } });
  expect(result.usage).toBeUndefined();
  expect(recorded[0]).toMatchObject({
    operation: 'extract',
    revision: 3,
    modelCalls: 2,
    requestBytes: requests[0].bytes + requests[1].bytes,
    context: [{ key: 'policy', version: 'v1' }],
    reference: expect.stringContaining('45 days')
  });

  // The budget is the size of the request as it is sent; one byte over is not sent.
  const tight = await load(requests[0].bytes - 1);
  expect(await tight.extract('How long?', { days: 'number' })).toMatchObject({
    errorCode: 'model_context_too_large'
  });
  expect(recorded[1]).toMatchObject({ success: false, modelCalls: 0, requestBytes: 0 });
  expect(requests).toHaveLength(2);
  await new Promise(resolve => space.close(resolve));
}, 20000);
