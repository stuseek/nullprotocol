const { createRuntime } = require('../runtime');
const settings = {
  provider: 'test',
  model: 'test',
  instructions: 'Private agent instruction',
  revision: 1
};
const evidence = {
  id: '00000000-0000-4000-8000-000000000001',
  query: 'returns',
  profile: 'test',
  sources: [
    {
      sourceId: 'source',
      name: 'Returns',
      revision: 1,
      passages: [{ start: 0, end: 8, heading: 'Policy', text: '30 days.' }]
    }
  ]
};
function fixture(reply) {
  const store = {
    turn: jest.fn(async (_keys, _budget, query) => ({
      settings,
      entries: [],
      notes: [],
      missing: [],
      ...(query !== undefined && { knowledge: { ...evidence, query } })
    })),
    settings: jest.fn(async () => settings),
    record: jest.fn(async () => {}),
    recordAction: jest.fn(async () => {})
  };
  const complete = jest.fn(async (_system, _messages, _limit, count) => {
    count.sent(100);
    count.answered({ inputTokens: 20, outputTokens: 5 });
    return { text: JSON.stringify(reply) };
  });
  return {
    store,
    complete,
    agent: createRuntime({
      agentId: 'support',
      store,
      credentials: {},
      modelFactory: () => ({ complete })
    })
  };
}
test.each([
  ['extract', ['return period', { days: 'number' }], { days: 30 }, 'return period'],
  [
    'summarize',
    ['A customer asks about returns.'],
    { summary: 'Return request.', keyPoints: [] },
    'A customer asks about returns.'
  ],
  [
    'validate',
    ['Must match policy', 'Returns within 30 days'],
    { score: 1, reasoning: 'Matches', recommendation: 'pass' },
    '{"subject":"Returns within 30 days","criteria":"Must match policy"}'
  ],
  [
    'decide',
    ['Return request', ['refund', 'review']],
    { action: 'review', parameters: {}, reasoning: 'Review' },
    'Return request'
  ]
])(
  'Knowledge opt-in is consistent for %s and leaves evidence in the record',
  async (name, input, reply, query) => {
    const { store, complete, agent } = fixture(reply);
    const result = await agent[name](...input, { knowledge: true });
    expect(result.success).toBe(true);
    expect(store.turn.mock.calls[0][2]).toBe(query);
    expect(complete.mock.calls[0][0]).toContain('30 days.');
    expect(result.knowledge.query).toBe(query);
    expect(store.record.mock.calls[0][0].knowledgeSearchId).toBe(evidence.id);
    expect(store.record.mock.calls[0][0].input.knowledge).toBe(true);
  }
);
test('omitted/false means no search; an explicit query overrides a long input without cutting it', async () => {
  const { store, complete, agent } = fixture({ summary: 'Short.', keyPoints: [] });
  await agent.summarize('short');
  await agent.summarize('short', { knowledge: false });
  expect(store.turn.mock.calls.slice(0, 2).every(call => call[2] === undefined)).toBe(true);
  const long = 'long input '.repeat(1000);
  const result = await agent.summarize(long, { knowledge: { query: 'returns' } });
  expect(result.success).toBe(true);
  expect(complete.mock.calls.at(-1)[1][0].content).toContain(long);
  expect(store.turn.mock.calls.at(-1)[2]).toBe('returns');
  const tooLong = await agent.summarize(long, { knowledge: true });
  expect(tooLong.errorCode).toBe('knowledge_query_too_large');
  expect(complete).toHaveBeenCalledTimes(3);
});
test('missing/unready Knowledge never becomes an ordinary generation; bad options never dispatch', async () => {
  const { store, complete, agent } = fixture({ days: 30 });
  store.turn.mockImplementation(async () => ({
    settings,
    entries: [],
    notes: [],
    missing: [],
    knowledgeError: 'knowledge_not_ready'
  }));
  expect((await agent.extract('returns', { days: 'number' }, { knowledge: true })).errorCode).toBe(
    'knowledge_not_ready'
  );
  expect(complete).not.toHaveBeenCalled();
  expect(store.record.mock.calls[0][0].modelCalls).toBe(0);
  expect(
    (await agent.extract('returns', { days: 'number' }, { knowledge: { query: '' } })).errorCode
  ).toBe('knowledge_query_required');
  expect(
    (await agent.extract('returns', { days: 'number' }, { knowledge: 'auto' })).errorCode
  ).toBe('invalid_knowledge_option');
});
test('Knowledge and explicit validate reference are both retained; repair uses one selection', async () => {
  const { store, complete, agent } = fixture({
    score: 1,
    reasoning: 'Matches',
    recommendation: 'pass'
  });
  complete.mockImplementationOnce(async () => ({ text: 'bad json' }));
  const result = await agent.validate('Must match', 'Returns', {
    knowledge: true,
    reference: 'Additional explicit reference.'
  });
  expect(result.success).toBe(true);
  expect(store.turn).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1][1][0].content).toContain('Additional explicit reference.');
  expect(complete.mock.calls[1][0]).toContain('30 days.');
});

test('standalone Knowledge fails without contacting a hosted service, and non-cloneable options are failures', async () => {
  const { NullProtocol } = require('..');
  const fetched = jest.spyOn(globalThis, 'fetch');
  try {
    const agent = await NullProtocol.create({ provider: 'ollama', model: 'test' });
    const result = await agent.extract('returns', { days: 'number' }, { knowledge: true });
    expect(result.errorCode).toBe('knowledge_unavailable');
    expect(
      (await agent.extract('returns', { days: 'number' }, { knowledge: () => true })).errorCode
    ).toBe('invalid_knowledge_option');
    expect(fetched).not.toHaveBeenCalled();
  } finally {
    fetched.mockRestore();
  }
});

test('failed search keeps its embedding usage separate from generation', async () => {
  const { store, complete, agent } = fixture({ days: 30 });
  store.turn.mockImplementation(async () => ({
    settings,
    entries: [],
    notes: [],
    missing: [],
    knowledgeError: 'knowledge_changed',
    knowledgeUsage: { inputTokens: 12 }
  }));
  const result = await agent.extract('returns', { days: 'number' }, { knowledge: true });
  expect(result.knowledgeUsage).toEqual({ inputTokens: 12 });
  expect(result.usage).toBeUndefined();
  expect(result.knowledge).toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
  expect(store.record.mock.calls[0][0].result.knowledgeUsage.inputTokens).toBe(12);
});
