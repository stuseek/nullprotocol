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
      requests.push({ ...JSON.parse(body), url: request.url, bytes: Buffer.byteLength(body) });
      const reply = replies.shift();
      response.setHeader('Content-Type', 'application/json');
      if (reply.status) {
        response.statusCode = reply.status;
        return response.end(JSON.stringify({ error: reply.error }));
      }
      // Ollama's own API has its own reply.
      if (request.url === '/api/chat') {
        return response.end(
          JSON.stringify({
            message: { content: JSON.stringify(reply) },
            done_reason: 'stop',
            prompt_eval_count: 30,
            eval_count: 6
          })
        );
      }
      const {
        content = reply,
        finish,
        usage = { prompt_tokens: 10, completion_tokens: 5 }
      } = reply;
      return response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: finish,
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
  expect(
    await agent.validate('Is it polite?', 'Thank you!', { reference: 'Our tone guide.' })
  ).toMatchObject({ success: true, recommendation: 'pass' });
  expect(requests.at(-1).messages[1].content).toContain('Reference: "Our tone guide."');
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
  expect(requests.at(-1).messages[1].content).toContain('Available actions: [{"action":"chat"');
  expect(requests.at(-1).messages[1].content).not.toContain('"action":"refund"');
  expect(await agent.decide('Refund please', ['refund'])).toMatchObject({
    errorCode: 'action_disabled'
  });
  expect(refund).toHaveBeenCalledTimes(1);
});

test('a decision is shown the description and schema an action was registered with', async () => {
  const agent = await create();
  const input = {
    type: 'object',
    properties: { creditEuro: { type: 'number' }, receiptId: { type: 'string' } },
    required: ['creditEuro', 'receiptId']
  };
  agent.registerAction('credit', parameters => parameters, {
    description: 'Give store credit for a receipt',
    input
  });
  replies.push({ action: 'credit', parameters: { creditEuro: 12, receiptId: 'R-7' } });
  const decision = await agent.decide('Credit 12 EUR for receipt R-7', ['credit', 'escalate']);
  expect(requests[0].messages[1].content).toContain(
    JSON.stringify([
      { action: 'credit', description: 'Give store credit for a receipt', parameters: input },
      { action: 'escalate' }
    ])
  );
  expect(await agent.execute(decision)).toMatchObject({
    outcome: 'completed',
    result: { creditEuro: 12, receiptId: 'R-7' }
  });

  // Chat without a message answers what the decision was about, also when that is an object.
  replies.push({ action: 'chat', parameters: {} }, 'Hello.');
  await agent.execute(await agent.decide({ question: 'Hi?' }, ['chat']));
  expect(requests.at(-1).messages[1].content).toBe('{"question":"Hi?"}');
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
  const asked = [];
  const source = {
    documentId: 'd1',
    name: 'Terms',
    revision: 2,
    whole: false,
    passages: [{ heading: 'Gifts', start: 40, end: 61 }]
  };
  const space = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      if (request.method === 'POST') {
        (request.url.endsWith('/turn') ? asked : recorded).push(JSON.parse(body));
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          agent: { provider: 'openai-compatible', model: 'test', instructions: '', revision: 3 },
          entries: [{ key: 'policy', value: 'Returns within 45 days.', version: 'v1' }],
          notes: [],
          missing: [],
          pending: [{ documentId: 'd2', name: 'New rules', revision: 1, state: 'preparing' }],
          documents: [
            {
              id: 'd1',
              name: 'Terms',
              revision: 2,
              whole: false,
              passages: [{ heading: 'Gifts', start: 40, end: 61, text: 'Gift cards are final.' }]
            }
          ]
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
    reference: expect.stringContaining('45 days'),
    sources: [source],
    // A document that was not in effect yet is named, not given.
    pending: [{ documentId: 'd2', name: 'New rules', revision: 1, state: 'preparing' }]
  });
  // The turn was asked with the task, and the model is sent the passage it
  // gave; history keeps the passage as a range of the revision, not as text.
  expect(asked[0]).toMatchObject({ query: 'How long?\n{"days":"number"}' });
  expect(systemOf(0)).toContain('[Terms › Gifts]\nGift cards are final.');
  expect(recorded[0].reference).not.toContain('Gift cards');

  // The budget is the size of the request as it is sent; one byte over is not sent.
  const tight = await load(requests[0].bytes - 1);
  expect(await tight.extract('How long?', { days: 'number' })).toMatchObject({
    errorCode: 'model_context_too_large'
  });
  // An operation that never reached the model still says what it ran with.
  expect(recorded[1]).toMatchObject({
    success: false,
    modelCalls: 0,
    requestBytes: 0,
    sources: [source]
  });
  expect(requests).toHaveLength(2);
  await new Promise(resolve => space.close(resolve));
}, 20000);

test('tokens the provider counted are kept when the operation fails, and an uncounted request is named', async () => {
  const agent = await create();
  replies.push({ status: 503 }, { content: '{"days":', finish: 'length' });
  expect(await agent.extract('How long?', { days: 'number' })).toEqual({
    success: false,
    error: "The model's reply is incomplete: length",
    errorCode: 'provider_error',
    usage: { inputTokens: 10, outputTokens: 5, uncountedRequests: 1 }
  });

  // Anthropic counts what the prompt cache held apart from input_tokens.
  const fetched = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: async () =>
      JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"days":45}' }],
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2000,
          output_tokens: 7
        }
      })
  });
  const claude = await NullProtocol.create({ provider: 'anthropic', model: 'claude', apiKey: 'k' });
  expect((await claude.extract('How long?', { days: 'number' })).usage).toEqual({
    inputTokens: 2104,
    outputTokens: 7
  });
  fetched.mockRestore();
});

test('Ollama is asked through its own API, which refuses a request larger than the window', async () => {
  const agent = await NullProtocol.create({
    provider: 'ollama',
    model: 'test',
    baseURL: baseURL.replace('/v1', '')
  });
  replies.push({ days: 45 }, { status: 400, error: 'request(9016 tokens) exceeds context(2048)' });
  expect(await agent.extract('How long?', { days: 'number' })).toMatchObject({
    data: { days: 45 },
    usage: { inputTokens: 30, outputTokens: 6 }
  });
  expect(requests[0]).toMatchObject({ url: '/api/chat', truncate: false, shift: false });
  expect(await agent.extract('How long?', { days: 'number' })).toEqual({
    success: false,
    error:
      "The request takes 9016 tokens and the model's window is 2048. Nothing was left out and the model did not answer. Send less context, or give the model a larger window.",
    errorCode: 'model_context_too_large'
  });
});
