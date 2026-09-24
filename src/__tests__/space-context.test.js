const { SpaceContextClient, SpaceContextError } = require('../space-context');
const NullProtocol = require('../index');

const key = `np_ctx_${'a'.repeat(43)}`;
const version = '00000000-0000-4000-8000-000000000001';

test('shared context is opt-in and separate from model and telemetry credentials', () => {
  const standalone = new NullProtocol({ engines: { openai: 'model-key' } });
  expect(standalone.spaceContext).toBeNull();
  const connected = new NullProtocol({
    engines: { openai: 'model-key' },
    spaceContextKey: key,
    spaceContextEndpoint: 'https://api.nullprotocol.ai'
  });
  expect(connected.spaceContext).toBeInstanceOf(SpaceContextClient);
  expect(connected.telemetry).toBeNull();
  expect(
    () => new NullProtocol({ engines: { openai: 'model-key' }, spaceContextKey: key })
  ).toThrow();
});

test('explicit requests carry CAS versions and scoped authorization', async () => {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: init.method === 'PUT' ? 201 : 200,
      text: async () => JSON.stringify({ document: { value: { n: 1 }, version } })
    };
  });
  const client = new SpaceContextClient({
    key,
    endpoint: 'https://api.nullprotocol.ai/',
    fetchImpl
  });
  expect((await client.get('ops', 'last-check')).version).toBe(version);
  await client.put('ops', 'last-check', { n: 1 }, { ifVersion: null, ttlSeconds: 60 });
  await client.delete('ops', 'last-check', version);
  expect(calls.map(call => call.init.method)).toEqual(['GET', 'PUT', 'DELETE']);
  expect(calls[0].url).toBe('https://api.nullprotocol.ai/v1/context/ops/last-check');
  expect(calls.every(call => call.init.headers.Authorization === `Bearer ${key}`)).toBe(true);
  expect(JSON.parse(calls[1].init.body)).toEqual({
    value: { n: 1 },
    ifVersion: null,
    ttlSeconds: 60
  });
  expect(JSON.parse(calls[2].init.body)).toEqual({ ifVersion: version });
  await expect(client.put('ops', 'x', {}, {})).rejects.toThrow();
  await expect(client.put('../escape', 'x', {}, { ifVersion: null })).rejects.toThrow();
});

test('missing documents and conflicts have distinct results', async () => {
  const client = new SpaceContextClient({
    key,
    endpoint: 'https://api.nullprotocol.ai',
    fetchImpl: jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"error":"not_found"}' })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => '{"error":"version_conflict"}'
      })
  });
  await expect(client.get('ops', 'missing')).resolves.toBeNull();
  await expect(client.put('ops', 'missing', 1, { ifVersion: null })).rejects.toMatchObject({
    name: 'SpaceContextError',
    status: 409,
    code: 'version_conflict'
  });
  expect(SpaceContextError).toBe(NullProtocol.SpaceContextError);
});

test('a proxy 404 is reported instead of treating it as a missing document', async () => {
  const client = new SpaceContextClient({
    key,
    endpoint: 'https://api.nullprotocol.ai',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":"route_not_found"}'
    })
  });
  await expect(client.get('ops', 'stock')).rejects.toMatchObject({
    status: 404,
    code: 'route_not_found'
  });
});

test('malformed error payloads retain a typed request failure', async () => {
  const client = new SpaceContextClient({
    key,
    endpoint: 'https://api.nullprotocol.ai',
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'null' })
  });
  await expect(client.get('ops', 'stock')).rejects.toMatchObject({
    name: 'SpaceContextError',
    status: 502,
    code: 'request_failed'
  });
});
