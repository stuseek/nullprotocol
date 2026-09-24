const { serveAgents, MemorySessionStore } = require('../index');

let server;
let root;
const auth = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };

async function call(path, method = 'GET', body, headers = auth) {
  const response = await global.fetch(root + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  server = serveAgents({
    port: 0,
    apiKey: 'test-key',
    store: new MemorySessionStore(),
    agents: [
      {
        id: 'worker',
        mode: 'stateless',
        engines: { openai: 'test' },
        tools: [{ name: 'read_logs', description: 'Read logs' }],
        onToolCall: async () => ({ ok: true })
      },
      { id: 'companion', mode: 'stateful', engines: { openai: 'test' } }
    ]
  });
  await new Promise(resolve => server.on('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  for (const { base } of server.agents.values()) {
    base.chat = jest.fn(async function (prompt) {
      const before = this.messages.length;
      this.messages.push({ role: 'user', content: prompt });
      return { success: true, message: String(before), runId: this.runContext.getStore()?.runId };
    });
  }
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  jest.restoreAllMocks();
});

test('one process serves stable agents and stateless calls stay isolated', async () => {
  expect((await call('/v1/agents')).body.agents.map(a => a.id)).toEqual(['worker', 'companion']);
  const a = await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: 'one' } });
  const b = await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: 'two' } });
  expect(a.body.output.message).toBe('0');
  expect(b.body.output.message).toBe('0');
  expect(a.body.output.runId).toBe(a.body.runId);
  expect(a.body.runId).not.toBe(b.body.runId);
});

test('sessions retain history, then clear or delete it', async () => {
  const made = await call('/v1/agents/companion/sessions', 'POST', { context: { map: 'forest' } });
  expect(made.status).toBe(201);
  const path = `/v1/agents/companion/sessions/${made.body.sessionId}`;
  expect((await call(`${path}/messages`, 'POST', { prompt: 'hello' })).body.output.message).toBe(
    '0'
  );
  expect((await call(`${path}/messages`, 'POST', { prompt: 'again' })).body.output.message).toBe(
    '1'
  );
  expect((await call(`${path}/history`, 'DELETE')).status).toBe(200);
  expect((await call(`${path}/messages`, 'POST', { prompt: 'fresh' })).body.output.message).toBe(
    '0'
  );
  expect((await call(`${path}/context`, 'DELETE')).status).toBe(200);
  expect((await call(path, 'DELETE')).status).toBe(200);
  expect((await call(`${path}/messages`, 'POST', { prompt: 'gone' })).status).toBe(404);
});

test('disable blocks new calls without creating more agents', async () => {
  expect((await call('/v1/agents/worker/disable', 'POST')).status).toBe(200);
  expect(
    (await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: 'blocked' } })).status
  ).toBe(409);
  expect((await call('/v1/agents/worker/enable', 'POST')).status).toBe(200);
  expect(
    (await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: 'allowed' } })).status
  ).toBe(200);
  expect((await call('/v1/agents')).body.agents).toHaveLength(2);
});

test('invalid server-owned guard configuration fails before listening', () => {
  for (const callOptions of [{ guard: 'yes' }, { guard: () => true, guardTimeoutMs: 0 }]) {
    expect(() =>
      serveAgents({
        port: 0,
        apiKey: 'test-key',
        agents: [{ id: 'invalid', mode: 'stateless', engines: { openai: 'test' }, callOptions }]
      })
    ).toThrow(/guard/i);
  }
});

test('authentication and malformed input are rejected', async () => {
  expect((await call('/v1/agents', 'GET', undefined, {})).status).toBe(401);
  expect((await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: '' } })).status).toBe(
    400
  );
  expect((await call('/v1/agents/unknown/invoke', 'POST', { input: { prompt: 'x' } })).status).toBe(
    404
  );
});

test('provider errors are not returned to HTTP callers', async () => {
  const base = server.agents.get('worker').base;
  const original = base.chat;
  base.chat = jest.fn(async () => ({ success: false, error: 'sensitive-provider-detail' }));
  try {
    const response = await call('/v1/agents/worker/invoke', 'POST', { input: { prompt: 'hello' } });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('sensitive-provider-detail');
  } finally {
    base.chat = original;
  }
});

test('tools are offered only to chat', async () => {
  const base = server.agents.get('worker').base;
  const original = base.decide;
  base.decide = jest.fn(async () => ({ success: true, action: 'wait', confidence: 1 }));
  try {
    const response = await call('/v1/agents/worker/invoke', 'POST', {
      operation: 'decide',
      input: { context: 'quiet', actions: ['wait', 'inspect'] }
    });
    expect(response.status).toBe(200);
    expect(base.decide.mock.calls[0][2].tools).toBeUndefined();
    expect(base.decide.mock.calls[0][2].onToolCall).toBeUndefined();
  } finally {
    base.decide = original;
  }
});

test('session store enforces owner and lease', async () => {
  const store = new MemorySessionStore({ maxSessions: 1 });
  const id = await store.create({ agent: 'x', principal: 'alice' }, { messages: [], context: {} });
  const ref = { id, agent: 'x', principal: 'alice' };
  expect((await store.acquire({ ...ref, principal: 'bob' })).status).toBe('not_found');
  const lease = await store.acquire(ref);
  expect(lease.status).toBe('acquired');
  expect((await store.acquire(ref)).status).toBe('busy');
  expect(await store.renew(ref, lease.lease, 30000)).toBe(true);
  expect(await store.delete(ref)).toBe('busy');
  await store.release(ref, lease.lease);
  expect(await store.delete(ref)).toBe('deleted');
});

test('session limits isolate principals and report capacity clearly', async () => {
  const store = new MemorySessionStore({ maxSessions: 2, maxSessionsPerPrincipal: 1 });
  await store.create({ agent: 'a', principal: 'alice' });
  await expect(store.create({ agent: 'b', principal: 'alice' })).rejects.toMatchObject({
    status: 429,
    code: 'session_limit_reached'
  });
  await store.create({ agent: 'a', principal: 'bob' });
  await expect(store.create({ agent: 'a', principal: 'carol' })).rejects.toMatchObject({
    status: 503,
    code: 'session_store_full'
  });
});

test('operations and tool output are controlled by the agent definition', async () => {
  const restricted = serveAgents({
    port: 0,
    handleSignals: false,
    apiKey: 'test-key',
    agents: [{ id: 'reader', mode: 'stateless', engines: { openai: 'test' }, operations: ['chat'] }]
  });
  try {
    await new Promise(resolve => restricted.once('listening', resolve));
    const url = `http://127.0.0.1:${restricted.address().port}/v1/agents/reader/invoke`;
    const agent = restricted.agents.get('reader');
    agent.base.chat = jest.fn(async () => ({
      success: true,
      message: 'done',
      toolCalls: [{ name: 'internal', parameters: { secret: 'x' }, result: { secret: 'y' } }]
    }));
    const invoke = body =>
      global.fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    expect((await invoke({ operation: 'decide', input: { actions: ['a'] } })).status).toBe(403);
    const response = await (await invoke({ input: { prompt: 'hello' } })).json();
    expect(response.output.message).toBe('done');
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(agent.base.chat).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise(resolve => restricted.close(resolve));
  }
});

test('invalid agent limits fail at startup', () => {
  for (const option of [
    { operations: ['unknown'] },
    { operations: ['chat', 'chat'] },
    { maxHistoryMessages: 0 },
    { maxHistoryMessages: -1 },
    { exposeToolCalls: 'yes' }
  ]) {
    expect(() =>
      serveAgents({
        port: 0,
        handleSignals: false,
        apiKey: 'test-key',
        agents: [{ id: 'invalid', mode: 'stateless', engines: { openai: 'test' }, ...option }]
      })
    ).toThrow();
  }
});

test('custom identity scopes agent listing and management', async () => {
  const managed = serveAgents({
    port: 0,
    handleSignals: false,
    authenticate: async req => {
      if (req.headers.authorization === 'Bearer alice') {
        return { principal: 'alice', agents: ['allowed'], canManage: false };
      }
      if (req.headers.authorization === 'Bearer bob') {
        return { principal: 'bob', agents: null, canManage: 'yes' };
      }
      return null;
    },
    agents: [
      { id: 'allowed', mode: 'stateless', engines: { openai: 'test' } },
      { id: 'hidden', mode: 'stateless', engines: { openai: 'test' } }
    ]
  });
  try {
    await new Promise(resolve => managed.on('listening', resolve));
    const url = `http://127.0.0.1:${managed.address().port}`;
    const headers = { Authorization: 'Bearer alice' };
    const list = await global.fetch(`${url}/v1/agents`, { headers }).then(r => r.json());
    expect(list.agents.map(a => a.id)).toEqual(['allowed']);
    expect(
      (await global.fetch(`${url}/v1/agents/hidden/invoke`, { method: 'POST', headers })).status
    ).toBe(403);
    expect(
      (await global.fetch(`${url}/v1/agents/allowed/disable`, { method: 'POST', headers })).status
    ).toBe(403);
    expect(
      (
        await global.fetch(`${url}/v1/agents`, {
          headers: { Authorization: 'Bearer bob' }
        })
      ).status
    ).toBe(403);
  } finally {
    await new Promise(resolve => managed.close(resolve));
  }
});
