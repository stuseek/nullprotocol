const { NullProtocol, AgentError } = require('..');

const valid = { provider: 'ollama', model: 'test' };

test.each([
  ['create', undefined],
  ['create', null],
  ['create', []],
  ['create', {}],
  ['create', { ...valid, provider: 'unknown' }],
  ['create', { ...valid, model: ' ' }],
  ['create', { ...valid, instructions: {} }],
  ['create', { ...valid, key: '' }],
  ['create', { ...valid, agentId: 42 }],
  ['create', { ...valid, endpoint: {} }],
  ['load', undefined],
  ['load', { key: 'space-key' }],
  ['load', { key: 'space-key', agentId: ' ' }],
  ['load', { key: 42, agentId: 'support' }],
  ['load', { key: 'space-key', agentId: 'support', endpoint: [] }]
])('%s refuses invalid setup before any network request (%j)', async (method, options) => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  try {
    await expect(NullProtocol[method](options)).rejects.toBeInstanceOf(AgentError);
    await expect(NullProtocol[method](options)).rejects.toMatchObject({ code: 'invalid_options' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test('missing saved/hosted keys retain the established key_required contract', async () => {
  await expect(NullProtocol.load({ agentId: 'support' })).rejects.toMatchObject({
    code: 'key_required'
  });
  await expect(
    NullProtocol.create({ provider: 'nullprotocol', model: 'ministral-14b' })
  ).rejects.toMatchObject({ code: 'key_required' });
});
