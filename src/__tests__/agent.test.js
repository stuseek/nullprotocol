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
      requests.push(JSON.parse(body));
      const reply = replies.shift();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
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
  replies.push({ days: 'many' }, { days: 30 });
  expect(await agent.extract('How long?', { days: 'number' })).toMatchObject({
    data: { days: 30 },
    attempts: 2,
    repaired: true
  });
  expect(requests[1].messages.at(-1).content).toMatch(/does not match the schema/);

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
  agent.registerAction('refund', refund, {
    input: { type: 'object', properties: { orderId: { type: 'number' } }, required: ['orderId'] },
    guard: ({ orderId }) => {
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

  const decision = await decide({ orderId: 42 });
  const runs = await Promise.all([agent.execute(decision), agent.execute(decision)]);
  expect(runs.map(run => run.errorCode ?? run.outcome)).toEqual(['completed', 'already_executed']);
  expect(refund).toHaveBeenCalledTimes(1);

  await agent.update({ paused: true });
  expect(await agent.extract('x', { days: 'number' })).toMatchObject({ errorCode: 'agent_paused' });
  await agent.update({ paused: false });
  const late = await decide({ orderId: 7 });
  await agent.update({ paused: true });
  expect(await agent.execute(late)).toMatchObject({
    outcome: 'refused',
    errorCode: 'agent_paused'
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
