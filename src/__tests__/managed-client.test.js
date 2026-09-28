const { NullProtocolClient, NullProtocol } = require('../index');
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
  expect(api.calls.map(call => new URL(call.url).pathname)).toEqual([
    '/v1/space',
    '/v1/spaces/demo/templates',
    '/v1/spaces/demo/managed-agents',
    `/v1/spaces/demo/managed-agents/${AGENT_ID}`
  ]);
  expect(api.calls[1].options.headers.get('Idempotency-Key')).toBe('deploy-1');
  expect(api.calls[2].options.headers.get('Idempotency-Key')).toBe('deploy-2');
  expect(
    api.calls.every(call => call.options.headers.get('Authorization') === `Bearer ${SPACE_KEY}`)
  ).toBe(true);
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
  expect(api.fetchImpl).not.toHaveBeenCalled();
});
