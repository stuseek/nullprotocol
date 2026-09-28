const { ManagedExecutor } = require('../managed-executor');
const { hashJson } = require('../managed-canonical');

const agentId = '22222222-2222-4222-8222-222222222222';
const otherAgentId = '55555555-5555-4555-8555-555555555555';
const runId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const executorKey = `np_space_${'A'.repeat(43)}`;
const config = {
  instructions: 'Answer briefly.',
  model: { provider: 'local', model: 'test-model', credentialRef: 'localModel' },
  actions: [],
  context: { spaceKeys: [] },
  memory: { mode: 'conversation' }
};

test('one executor claims, traces and commits a conversation turn', async () => {
  const calls = [];
  const job = {
    run: {
      id: runId,
      agentId,
      conversationId,
      deadlineAt: new Date(Date.now() + 180000).toISOString(),
      input: 'Where is my order?',
      context: { order: { status: 'shipped' } }
    },
    lease: {
      token: `np_lease_${'B'.repeat(43)}`,
      expiresAt: new Date(Date.now() + 30000).toISOString()
    },
    template: { contentHash: hashJson(config), config },
    spaceContext: [],
    conversation: { id: conversationId, version: 7, messages: [] }
  };
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(
        JSON.stringify({ space: { id: 's', slug: 'demo', name: 'Demo' } })
      );
    }
    if (url.endsWith('/claim')) return new globalThis.Response(JSON.stringify({ job }));
    if (url.endsWith('/commit')) {
      return new globalThis.Response(
        JSON.stringify({ run: { id: runId, status: 'succeeded', output: { text: 'Shipped' } } })
      );
    }
    return new globalThis.Response(JSON.stringify({ accepted: 1, executor: { instanceId: 'x' } }));
  });
  const modelFetchImpl = jest.fn(
    async () =>
      new globalThis.Response(
        JSON.stringify({
          choices: [{ message: { content: 'Shipped' } }],
          usage: { prompt_tokens: 20, completion_tokens: 2 }
        })
      )
  );
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: {
      localModel: {
        provider: 'local',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKey: 'model-secret'
      }
    },
    fetchImpl,
    modelFetchImpl
  });
  await executor.register();
  const result = await executor.pollOnce();
  expect(result.run.status).toBe('succeeded');
  expect(calls.filter(call => call.url.endsWith('/steps'))).toHaveLength(2);
  const commit = JSON.parse(calls.find(call => call.url.endsWith('/commit')).options.body);
  expect(commit.conversation).toEqual({
    id: conversationId,
    expectedVersion: 7,
    append: [
      { role: 'user', content: 'Where is my order?' },
      { role: 'assistant', content: 'Shipped' }
    ]
  });
  expect(calls.map(call => call.options.body || '').join('')).not.toContain('model-secret');
  expect(modelFetchImpl).toHaveBeenCalledTimes(1);
});

test('a missing selected Space Context key fails without calling the model', async () => {
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    if (url.endsWith('/commit')) {
      return new globalThis.Response(JSON.stringify({ run: { id: runId, status: 'failed' } }));
    }
    return new globalThis.Response(JSON.stringify({ accepted: 1 }));
  });
  const modelFetchImpl = jest.fn();
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    fetchImpl,
    modelFetchImpl
  });
  const result = await executor.processJob({
    run: {
      id: runId,
      agentId,
      input: 'Hi',
      conversationId: null,
      deadlineAt: new Date(Date.now() + 180000).toISOString()
    },
    lease: {
      token: `np_lease_${'B'.repeat(43)}`,
      expiresAt: new Date(Date.now() + 30000).toISOString()
    },
    template: { contentHash: hashJson(config), config },
    spaceContext: [{ namespace: 'support', key: 'policy', present: false }],
    conversation: null
  });
  expect(result.run.status).toBe('failed');
  expect(modelFetchImpl).not.toHaveBeenCalled();
  expect(JSON.parse(calls.find(call => call.url.endsWith('/commit')).options.body)).toMatchObject({
    errorCode: 'context_unavailable'
  });
});

test('a cancellation observed after the provider answers commits cancelled without history', async () => {
  jest.useFakeTimers();
  try {
    const calls = [];
    let answer;
    const modelFetchImpl = jest.fn(
      () =>
        new Promise(resolve => {
          answer = () =>
            resolve(
              new globalThis.Response(
                JSON.stringify({ choices: [{ message: { content: 'Too late' } }] })
              )
            );
        })
    );
    const fetchImpl = jest.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/space')) {
        return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
      }
      if (url.endsWith('/lease')) {
        return new globalThis.Response(
          JSON.stringify({
            expiresAt: new Date(Date.now() + 30000).toISOString(),
            cancelRequested: true
          })
        );
      }
      if (url.endsWith('/commit')) {
        return new globalThis.Response(JSON.stringify({ run: { status: 'cancelled' } }));
      }
      return new globalThis.Response(JSON.stringify({ accepted: 1 }));
    });
    const executor = new ManagedExecutor({
      executorKey,
      agentIds: [agentId],
      credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
      fetchImpl,
      modelFetchImpl
    });
    const work = executor.processJob({
      run: {
        id: runId,
        agentId,
        input: 'Hi',
        conversationId,
        deadlineAt: new Date(Date.now() + 180000).toISOString()
      },
      lease: {
        token: `np_lease_${'B'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 30000).toISOString()
      },
      template: { contentHash: hashJson(config), config },
      spaceContext: [],
      conversation: { id: conversationId, version: 0, messages: [] }
    });
    await jest.advanceTimersByTimeAsync(1);
    expect(modelFetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(8000);
    answer();
    const result = await work;
    expect(result.run.status).toBe('cancelled');
    const commit = JSON.parse(calls.find(call => call.url.endsWith('/commit')).options.body);
    expect(commit).toMatchObject({ status: 'cancelled', conversation: null });
  } finally {
    jest.useRealTimers();
  }
});

test('one deleted Agent is removed from the manifest while other Agents stay served', async () => {
  const manifests = [];
  const errors = [];
  const fetchImpl = jest.fn(async (url, options) => {
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    const body = JSON.parse(options.body);
    manifests.push(body.agents);
    if (manifests.length === 1) {
      return new globalThis.Response(
        JSON.stringify({ error: 'invalid_body', unknownAgents: [agentId] }),
        { status: 400 }
      );
    }
    return new globalThis.Response(
      JSON.stringify({ executor: { instanceId: 'x', heartbeatSeconds: 10 } })
    );
  });
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId, otherAgentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    fetchImpl,
    onError: code => errors.push(code)
  });
  executor.running = true;
  executor.abortController = new AbortController();
  await executor._heartbeat();
  expect(executor.running).toBe(true);
  expect(executor.agentIds).toEqual([otherAgentId]);
  expect(manifests).toEqual([[agentId, otherAgentId], [otherAgentId]]);
  expect(errors).toEqual(['agent_removed']);
});

test('a transient heartbeat failure keeps the worker alive for recovery', async () => {
  const errors = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    fetchImpl: async url => {
      if (url.endsWith('/v1/space')) {
        return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
      }
      return new globalThis.Response(JSON.stringify({ error: 'platform_unavailable' }), {
        status: 503
      });
    },
    onError: code => errors.push(code)
  });
  executor.running = true;
  executor.abortController = new AbortController();
  await executor._heartbeat();
  expect(executor.running).toBe(true);
  expect(executor.abortController.signal.aborted).toBe(false);
  expect(errors).toEqual(['platform_unavailable']);
});
