const { savedStore } = require('../platform');
const { randomUUID } = require('crypto');
let original;
beforeEach(() => {
  original = global.fetch;
});
afterEach(() => {
  global.fetch = original;
});
const store = () =>
  savedStore({ key: 'fixture', endpoint: 'https://example.test', agentId: 'support' });

test('saved Context accepts JSON null and rejects malformed keys without an HTTP call', async () => {
  global.fetch = jest.fn(
    async (_url, options) =>
      new global.Response(
        JSON.stringify({
          entry: { ...JSON.parse(options.body), key: 'order', version: randomUUID() }
        })
      )
  );
  expect((await store().context.set('order', null)).value).toBeNull();
  const calls = global.fetch.mock.calls.length;
  for (const key of ['privateProbe', '../other', '', 'x'.repeat(65)]) {
    for (const method of ['get', 'set', 'delete']) {
      await expect(store().context[method](key, 1)).rejects.toMatchObject({
        code: 'invalid_context_key',
        field: 'key',
        message: expect.stringContaining('lowercase')
      });
    }
  }
  expect(global.fetch).toHaveBeenCalledTimes(calls);
});

test('bad Context values are value errors, not unavailable-platform errors', async () => {
  global.fetch = jest.fn();
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [undefined, () => 1, Symbol('x'), cyclic, 1n]) {
    await expect(store().space.set('order', value)).rejects.toMatchObject({
      code: 'invalid_context_value',
      field: 'value'
    });
  }
  expect(global.fetch).not.toHaveBeenCalled();
});
