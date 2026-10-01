const { NullProtocolClient, NullProtocol, defineAction } = require('../index');
const SPACE_KEY = `np_space_${'A'.repeat(43)}`;
const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

function fakeApi() {
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(
        JSON.stringify({ space: { id: 'space-1', slug: 'demo', name: 'Demo' } }),
        { status: 200 }
      );
    }
    if (url.endsWith('/templates') && options.method === 'POST') {
      return new globalThis.Response(
        JSON.stringify({ template: { id: TEMPLATE_ID }, version: { version: 1 } }),
        { status: 201 }
      );
    }
    if (url.endsWith('/managed-agents') && options.method === 'POST') {
      return new globalThis.Response(JSON.stringify({ agent: { id: AGENT_ID } }), { status: 201 });
    }
    return new globalThis.Response(JSON.stringify({ agent: { id: AGENT_ID } }), { status: 200 });
  });
  return { calls, fetchImpl };
}

test('discovers the Space once and sends management requests to managed routes', async () => {
  const api = fakeApi();
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await expect(
    client.templates.create({ name: 'Support', config: {} }, { idempotencyKey: 'deploy-1' })
  ).resolves.toMatchObject({ template: { id: TEMPLATE_ID } });
  await expect(
    client.agents.create({ templateId: TEMPLATE_ID }, { idempotencyKey: 'deploy-2' })
  ).resolves.toMatchObject({ agent: { id: AGENT_ID } });
  await client.agent(AGENT_ID).get();
  await client.agent(AGENT_ID).runtime();
  expect(api.calls.map(call => new URL(call.url).pathname)).toEqual([
    '/v1/space',
    '/v1/spaces/demo/templates',
    '/v1/spaces/demo/managed-agents',
    `/v1/spaces/demo/managed-agents/${AGENT_ID}`,
    `/v1/spaces/demo/managed-agents/${AGENT_ID}/runtime`
  ]);
  expect(api.calls[1].options.headers.get('Idempotency-Key')).toBe('deploy-1');
  expect(api.calls[2].options.headers.get('Idempotency-Key')).toBe('deploy-2');
  expect(
    api.calls.every(call => call.options.headers.get('Authorization') === `Bearer ${SPACE_KEY}`)
  ).toBe(true);
});

test('usage reads the Space quota and reported token totals', async () => {
  const requests = [];
  const fetchImpl = jest.fn(async url => {
    requests.push(new URL(url).pathname);
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    return new globalThis.Response(
      JSON.stringify({
        plan: 'free',
        day: '2026-09-28',
        limits: { activeRuns: 10 },
        usage: { activeRuns: 1 },
        tokens: { today: { input: 0, output: 0, runsWithoutUsage: 1 } }
      })
    );
  });
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  await expect(client.usage()).resolves.toMatchObject({
    plan: 'free',
    tokens: { today: { input: 0, output: 0, runsWithoutUsage: 1 } }
  });
  expect(requests).toEqual(['/v1/space', '/v1/spaces/demo/managed-usage']);
});

test('one action definition publishes the contract and registers the handler', async () => {
  const action = defineAction({
    name: 'getOrder',
    description: 'Read one order',
    input: { type: 'object' },
    output: { type: 'object' },
    effect: 'read',
    handler: async () => ({})
  });
  const api = fakeApi();
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await client.templates.create({ name: 'Support', config: { actions: [action] } });
  expect(JSON.parse(api.calls[1].options.body).config.actions).toEqual([
    {
      name: 'getOrder',
      description: 'Read one order',
      input: { type: 'object' },
      output: { type: 'object' },
      effect: 'read'
    }
  ]);
  expect(action.handler).toEqual(expect.any(Function));
  expect(Object.isFrozen(action.input)).toBe(true);
});

test('rejects an invalid idempotency key before creating a resource', async () => {
  const api = fakeApi();
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await expect(
    client.templates.create({ name: 'Support', config: {} }, { idempotencyKey: 'has space' })
  ).rejects.toThrow('idempotencyKey');
  expect(api.fetchImpl).not.toHaveBeenCalled();
});

test('a failed discovery is retried and the legacy constructor remains local', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    )
    .mockResolvedValueOnce(
      new globalThis.Response(JSON.stringify({ space: { id: 's', slug: 'demo', name: 'Demo' } }), {
        status: 200
      })
    );
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  await expect(client.space()).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(client.space()).resolves.toMatchObject({ slug: 'demo' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const legacy = new NullProtocol({ engines: { openai: 'test-key' } });
  expect(legacy).toHaveProperty('extract');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('rejects dot-segment IDs and wrong key types before contacting the API', async () => {
  const api = fakeApi();
  expect(
    () => new NullProtocolClient({ spaceKey: 'np_ingest_wrong', fetchImpl: api.fetchImpl })
  ).toThrow('Space key');
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await expect(client.agents.delete('..')).rejects.toThrow('UUID');
  await expect(client.templates.getVersion(TEMPLATE_ID, '..')).rejects.toThrow('positive integer');
  expect(api.fetchImpl).not.toHaveBeenCalled();
});

test('returns the asynchronous managed-Agent deletion state', async () => {
  const api = fakeApi();
  api.fetchImpl.mockImplementation(async (url, options) => {
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(
        JSON.stringify({ space: { id: 's', slug: 'demo', name: 'Demo' } }),
        { status: 200 }
      );
    }
    if (options.method === 'DELETE') {
      return new globalThis.Response(
        JSON.stringify({ deletion: { agentId: AGENT_ID, status: 'pending' } }),
        { status: 202 }
      );
    }
    throw new Error('unexpected request');
  });
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await expect(client.agents.delete(AGENT_ID)).resolves.toEqual({
    deletion: { agentId: AGENT_ID, status: 'pending' }
  });
});

test('action controls and reconciliation use the managed Agent routes', async () => {
  const runId = '33333333-3333-4333-8333-333333333333';
  const requests = [];
  const fetchImpl = jest.fn(async (url, options) => {
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    requests.push({ path: new URL(url).pathname, method: options.method, body: options.body });
    return new globalThis.Response(JSON.stringify({ ok: true }));
  });
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  const agent = client.agent(AGENT_ID);
  await agent.setAction('refund', { disabled: true, ifRevision: 1 });
  await agent.stop({ ifRevision: 2 });
  await agent.listSteps(runId);
  await agent.reconcileStep(runId, 3, { outcome: 'failed', note: 'No refund in ledger' });
  expect(requests.map(request => [request.method, request.path])).toEqual([
    ['PATCH', `/v1/spaces/demo/managed-agents/${AGENT_ID}/actions/refund`],
    ['POST', `/v1/spaces/demo/managed-agents/${AGENT_ID}/stop`],
    ['GET', `/v1/spaces/demo/managed-agents/${AGENT_ID}/runs/${runId}/steps`],
    ['POST', `/v1/spaces/demo/managed-agents/${AGENT_ID}/runs/${runId}/steps/3/reconcile`]
  ]);
  expect(JSON.parse(requests[3].body)).toEqual({
    outcome: 'failed',
    note: 'No refund in ledger'
  });
  await expect(agent.setAction('../refund', { disabled: true, ifRevision: 1 })).rejects.toThrow(
    'actionName'
  );
  await expect(agent.reconcileStep(runId, 256, { outcome: 'failed' })).rejects.toThrow('ordinal');
});

test('managed context and conversation content use scoped Agent routes', async () => {
  const requests = [];
  const fetchImpl = jest.fn(async (url, options) => {
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    requests.push({ path: new URL(url).pathname, method: options.method });
    return new globalThis.Response(JSON.stringify({ ok: true }));
  });
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  const agent = client.agent(AGENT_ID);
  await agent.context.put('profile', { value: { locale: 'en' }, ifVersion: null });
  await agent.memory.add({ text: 'Preferred locale is en' });
  await agent.conversations.get('cafe\u0301/42');
  await agent.conversations.deleteMessage('café/42', 2);
  expect(requests.map(request => [request.method, request.path])).toEqual([
    ['PUT', `/v1/spaces/demo/managed-agents/${AGENT_ID}/context/profile`],
    ['POST', `/v1/spaces/demo/managed-agents/${AGENT_ID}/memory`],
    ['GET', `/v1/spaces/demo/managed-agents/${AGENT_ID}/conversations/caf%C3%A9%2F42`],
    ['DELETE', `/v1/spaces/demo/managed-agents/${AGENT_ID}/conversations/caf%C3%A9%2F42/messages/2`]
  ]);
  expect(() => agent.context.get('../profile')).toThrow('contextKey');
  expect(() => agent.conversations.deleteMessage('ticket', 0)).toThrow('sequence');
  // "." and ".." would resolve as path steps to another route, such as the Agent itself.
  for (const key of ['.', '..']) {
    expect(() => agent.conversations.delete(key)).toThrow('cannot be');
    expect(() => agent.conversations.deleteFact(key, AGENT_ID)).toThrow('cannot be');
  }
  expect(requests).toHaveLength(4);
});

test('an abort signal cancels Space discovery before resource creation', async () => {
  const controller = new AbortController();
  const fetchImpl = jest.fn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        });
      })
  );
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  const request = client.templates.create(
    { name: 'Support', config: {} },
    {
      idempotencyKey: 'deploy-1',
      signal: controller.signal
    }
  );
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: 'request_aborted' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('agent.run starts and polls the same platform run', async () => {
  const runId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(
        JSON.stringify({ space: { id: 's', slug: 'demo', name: 'Demo' } })
      );
    }
    if (options.method === 'POST') {
      return new globalThis.Response(JSON.stringify({ run: { id: runId, status: 'accepted' } }), {
        status: 202
      });
    }
    return new globalThis.Response(
      JSON.stringify({ run: { id: runId, status: 'succeeded', output: { text: 'Shipped' } } })
    );
  });
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl });
  const run = await client.agent(AGENT_ID).run('Where is my order?', {
    conversation: 'ticket:456',
    context: { order: { status: 'shipped' } },
    idempotencyKey: 'ticket-456-message-1',
    pollIntervalMs: 100
  });
  expect(run).toMatchObject({ id: runId, status: 'succeeded' });
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/v1/space',
    `/v1/spaces/demo/managed-agents/${AGENT_ID}/runs`,
    `/v1/spaces/demo/managed-agents/${AGENT_ID}/runs/${runId}`
  ]);
  expect(JSON.parse(calls[1].options.body)).toEqual({
    input: 'Where is my order?',
    conversation: 'ticket:456',
    context: { order: { status: 'shipped' } }
  });
  expect(calls[1].options.headers.get('Idempotency-Key')).toBe('ticket-456-message-1');
});

test('bad run options cannot create a run', async () => {
  const api = fakeApi();
  const client = new NullProtocolClient({ spaceKey: SPACE_KEY, fetchImpl: api.fetchImpl });
  await expect(client.agent(AGENT_ID).run('Hello', { pollIntervalMs: 0 })).rejects.toThrow(
    'pollIntervalMs'
  );
  await expect(client.agent(AGENT_ID).startRun(undefined)).rejects.toThrow('input is required');
  // A conversation its key could never address again is not created.
  await expect(client.agent(AGENT_ID).run('Hello', { conversation: '.' })).rejects.toThrow(
    'cannot be'
  );
  expect(api.fetchImpl).not.toHaveBeenCalled();
});
