const { randomUUID } = require('crypto');
const { NullProtocol } = require('..');
const reply = (body, status = 200) => new global.Response(JSON.stringify(body), { status });
const id = randomUUID(),
  shared = randomUUID(),
  other = randomUUID();
let original, seen, source, library, connected, reads;
beforeEach(() => {
  original = global.fetch;
  seen = [];
  connected = false;
  reads = 0;
  source = {
    id,
    name: 'Returns',
    scope: 'agent',
    revision: 1,
    activeRevision: null,
    version: randomUUID(),
    text: '30 days.',
    state: 'preparing'
  };
  library = {
    id: shared,
    name: 'Shared rules',
    scope: 'space',
    revision: 1,
    version: randomUUID(),
    text: 'Shared text.',
    state: 'ready'
  };
  global.fetch = jest.fn(async (url, options) => {
    seen.push({ url, ...options, json: options.body && JSON.parse(options.body) });
    const path = new URL(url).pathname,
      body = options.body && JSON.parse(options.body);
    if (path.endsWith('/settings')) {
      return reply({ agent: { provider: 'nullprotocol', model: 'test', instructions: '' } });
    }
    if (path.includes('/knowledge-links/')) {
      connected = options.method === 'PUT';
      return reply({ attached: connected });
    }
    if (path.endsWith('/retry')) return reply({ retrying: false });
    const isSpace = path.startsWith('/v1/knowledge');
    if (path.endsWith('/knowledge') && options.method === 'GET') {
      reads++;
      return reply({
        sources: isSpace
          ? [library]
          : [
              source,
              { ...library, attached: connected },
              { id: other, scope: 'space', attached: false }
            ],
        usage: { preparation: '12', search: null, requests: 1, uncounted: 0 }
      });
    }
    const document = isSpace ? library : source;
    if (path.endsWith('/knowledge') && options.method === 'POST') {
      return reply({ id: document.id, revision: 1, version: document.version }, 201);
    }
    if (path.endsWith(`/${document.id}`)) {
      if (options.method === 'GET') return reply({ source: document });
      if (body.ifVersion !== document.version) return reply({ error: 'version_conflict' }, 409);
      if (options.method === 'DELETE') return reply({ deleted: true });
      if (Object.hasOwn(body, 'text') && body.text !== document.text) document.revision++;
      Object.assign(document, body, { version: randomUUID() });
      return reply({ id: document.id, revision: document.revision, version: document.version });
    }
    return reply({ error: 'knowledge_not_found' }, 404);
  });
});
afterEach(() => {
  global.fetch = original;
});
const load = () =>
  NullProtocol.load({
    key: 'test',
    agentId: 'support',
    conversation: 'order:42',
    endpoint: 'https://test.example'
  });

test('agent and Space documents use their own routes, exact text and explicit version guards', async () => {
  const agent = await load();
  const created = await agent.knowledge.add({ name: ' Returns ', text: '30 days.\n' });
  expect(created.id).toBe(id);
  expect(seen.at(-1).json).toEqual({ name: 'Returns', text: '30 days.\n' });
  expect((await agent.knowledge.list()).map(s => s.id)).toEqual([id]);
  const current = await agent.knowledge.get(id);
  const updated = await agent.knowledge.update(id, {
    text: '14 days.',
    ifVersion: current.version
  });
  expect(updated.revision).toBe(2);
  await expect(
    agent.knowledge.update(id, { text: '7 days.', ifVersion: current.version })
  ).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(agent.knowledge.delete(id, { ifVersion: current.version })).rejects.toMatchObject({
    code: 'version_conflict'
  });
  expect(await agent.knowledge.delete(id, { ifVersion: updated.version })).toEqual({
    deleted: true
  });
  await agent.space.knowledge.add({ name: 'Shared', text: 'Policy' });
  const common = await agent.space.knowledge.get(shared);
  await agent.space.knowledge.update(shared, { name: 'Renamed', ifVersion: common.version });
  expect((await agent.space.knowledge.list()).map(s => s.id)).toEqual([shared]);
  expect(
    seen.every(
      s => !s.url.includes('conversation') && (!s.json || !Object.hasOwn(s.json, 'conversation'))
    )
  ).toBe(true);
  expect(seen.every(s => s.headers.Authorization === 'Bearer test')).toBe(true);
});

test('connections are explicit and separate from agent ownership; shared usage preserves unknown sums', async () => {
  const agent = await load();
  expect(await agent.knowledge.connections()).toEqual([]);
  expect(await agent.knowledge.connect(shared)).toEqual({ attached: true });
  expect((await agent.knowledge.connections()).map(s => s.id)).toEqual([shared]);
  expect((await agent.knowledge.list()).map(s => s.id)).toEqual([id]);
  await expect(agent.knowledge.get(shared)).rejects.toMatchObject({ code: 'knowledge_not_found' });
  await agent.knowledge.disconnect(shared);
  expect(await agent.knowledge.connections()).toEqual([]);
  expect(await agent.space.knowledge.usage()).toEqual({
    preparation: '12',
    search: null,
    requests: 1,
    uncounted: 0
  });
  expect(await agent.knowledge.retry(id)).toEqual({ retrying: false });
  expect(await agent.space.knowledge.retry(shared)).toEqual({ retrying: false });
});

test.each([
  null,
  {},
  { name: 'x' },
  { name: 'x', text: '' },
  { name: 'x', text: '  ' },
  { name: 'bad\nname', text: 'valid' },
  { name: 'x', text: 'bad\0text' },
  { name: 'x', text: '\ud800' },
  { name: 'x', text: 'ok', extra: true }
])('invalid source input does not dispatch: %p', async input => {
  const agent = await load(),
    before = seen.length;
  await expect(agent.knowledge.add(input)).rejects.toMatchObject({ code: 'invalid_options' });
  expect(seen).toHaveLength(before);
});

test('size is UTF-8 bytes, update/delete require versions, malformed IDs never enter paths', async () => {
  const agent = await load();
  await expect(
    agent.knowledge.add({ name: 'Large', text: 'é'.repeat(524289) })
  ).rejects.toMatchObject({ code: 'knowledge_document_too_large' });
  await expect(agent.knowledge.update(id, { text: 'x' })).rejects.toMatchObject({
    code: 'invalid_options'
  });
  await expect(agent.knowledge.update(id, { ifVersion: source.version })).rejects.toMatchObject({
    code: 'invalid_options'
  });
  await expect(agent.knowledge.delete(id)).rejects.toMatchObject({ code: 'invalid_options' });
  await expect(agent.knowledge.connect('../other')).rejects.toMatchObject({
    code: 'invalid_options'
  });
  await expect(agent.knowledge.get('../other')).rejects.toMatchObject({ code: 'invalid_options' });
  expect(seen).toHaveLength(1);
});

test('a lost create response is not retried; standalone management fails without a network call', async () => {
  const agent = await load();
  global.fetch.mockImplementation(async () => {
    throw new Error('Response lost');
  });
  await expect(agent.knowledge.add({ name: 'Policy', text: 'Rules' })).rejects.toMatchObject({
    code: 'platform_unavailable'
  });
  expect(global.fetch).toHaveBeenCalledTimes(2); // settings + one create
  const local = await NullProtocol.create({ provider: 'ollama', model: 'test' });
  const before = global.fetch.mock.calls.length;
  await expect(local.knowledge.list()).rejects.toMatchObject({ code: 'knowledge_unavailable' });
  await expect(local.space.knowledge.add({ name: 'Policy', text: 'Rules' })).rejects.toMatchObject({
    code: 'knowledge_unavailable'
  });
  expect(global.fetch).toHaveBeenCalledTimes(before);
});
