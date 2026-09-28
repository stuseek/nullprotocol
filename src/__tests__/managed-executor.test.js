const { ManagedExecutor } = require('../managed-executor');
const { hashJson, actionContractHash } = require('../managed-canonical');

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

test.each(['read', 'write', 'write-then-model-fails'])(
  'a declared %s action is schema checked, traced and returned to the model',
  async mode => {
    const effect = mode === 'read' ? 'read' : 'write';
    const failSecond = mode === 'write-then-model-fails';
    const action = {
      name: 'getOrder',
      description: 'Read an order',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      effect
    };
    const contractHash = actionContractHash(action);
    const actionConfig = { ...config, actions: [action] };
    const steps = [];
    const commits = [];
    const fetchImpl = jest.fn(async (url, options) => {
      if (url.endsWith('/v1/space')) {
        return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
      }
      if (url.endsWith('/lease')) {
        return new globalThis.Response(
          JSON.stringify({
            expiresAt: new Date(Date.now() + 30000),
            cancelRequested: false,
            disabledActions: []
          })
        );
      }
      if (url.endsWith('/context')) {
        return new globalThis.Response(JSON.stringify({ spaceContext: [], disabledActions: [] }));
      }
      if (url.endsWith('/steps')) {
        steps.push(JSON.parse(options.body).steps[0]);
        return new globalThis.Response(JSON.stringify({ accepted: 1 }));
      }
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(options.body));
        return new globalThis.Response(JSON.stringify({ run: { status: commits[0].status } }));
      }
      throw new Error('unexpected API request');
    });
    const modelRequests = [];
    const modelFetchImpl = jest.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      modelRequests.push(request);
      if (failSecond && modelRequests.length === 2) {
        return new globalThis.Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      }
      return new globalThis.Response(
        JSON.stringify(
          modelRequests.length === 1
            ? {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: 'provider-id',
                          type: 'function',
                          function: { name: 'getOrder', arguments: '{"id":"123"}' }
                        }
                      ]
                    }
                  }
                ]
              }
            : { choices: [{ message: { content: 'Your order shipped.' } }] }
        )
      );
    });
    const handler = jest.fn(async () => ({ status: 'shipped' }));
    const executor = new ManagedExecutor({
      executorKey,
      agentIds: [agentId],
      credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
      actions: [{ ...action, handler }],
      fetchImpl,
      modelFetchImpl
    });
    const result = await executor.processJob({
      run: {
        id: runId,
        agentId,
        input: 'Where is order 123?',
        conversationId,
        deadlineAt: new Date(Date.now() + 180000).toISOString()
      },
      lease: {
        token: `np_lease_${'B'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 30000).toISOString()
      },
      template: { contentHash: hashJson(actionConfig), config: actionConfig },
      actions: [{ ...action, contractHash }],
      actionManifestHash: hashJson([{ name: action.name, contractHash }]),
      spaceContext: [],
      conversation: { id: conversationId, version: 0, messages: [] },
      pendingOutcomes: []
    });
    expect(result.run.status).toBe(failSecond ? 'failed' : 'succeeded');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].idempotencyKey).toMatch(new RegExp(`^${runId}:`));
    expect(steps.map(step => [step.ordinal, step.kind, step.status])).toEqual([
      [0, 'model', 'started'],
      [0, 'model', 'succeeded'],
      [1, 'action', 'started'],
      [1, 'action', 'succeeded'],
      [2, 'model', 'started'],
      [2, 'model', failSecond ? 'failed' : 'succeeded']
    ]);
    expect(modelRequests[1].messages).toEqual(
      expect.arrayContaining([
        { role: 'tool', tool_call_id: 'provider-id', content: '{"status":"shipped"}' }
      ])
    );
    expect(commits[0].output).toEqual(failSecond ? null : { text: 'Your order shipped.' });
    if (effect === 'write') {
      expect(commits[0].conversation.append[1].content).toEqual({
        text: failSecond ? null : 'Your order shipped.',
        actionOutcomes: [{ name: 'getOrder', callId: expect.any(String), status: 'succeeded' }],
        ...(failSecond ? { errorCode: 'model_error' } : {})
      });
    }
  }
);

test('a write action does not start when its timeout cannot fit the run deadline', async () => {
  const action = {
    name: 'refund',
    description: 'Refund an order',
    input: { type: 'object' },
    output: { type: 'object' },
    effect: 'write',
    timeoutMs: 30000
  };
  const actionConfig = { ...config, actions: [action] };
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    if (url.endsWith('/v1/space')) {
      return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
    }
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/lease')) {
      return new globalThis.Response(
        JSON.stringify({ expiresAt: new Date(Date.now() + 30000), disabledActions: [] })
      );
    }
    if (url.endsWith('/context')) {
      return new globalThis.Response(JSON.stringify({ spaceContext: [], disabledActions: [] }));
    }
    if (url.endsWith('/commit')) {
      return new globalThis.Response(JSON.stringify({ run: { status: 'failed' } }));
    }
    return new globalThis.Response(JSON.stringify({ accepted: 1 }));
  });
  const handler = jest.fn(async () => ({ receipt: 'R-1' }));
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://127.0.0.1:11434/v1' } },
    actions: [{ ...action, handler }],
    fetchImpl,
    modelFetchImpl: async () =>
      new globalThis.Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'refund', arguments: '{}' }
                  }
                ]
              }
            }
          ]
        })
      )
  });
  const contractHash = actionContractHash(action);
  const result = await executor.processJob({
    run: {
      id: runId,
      agentId,
      input: 'Refund',
      conversationId: null,
      deadlineAt: new Date(Date.now() + 15000).toISOString()
    },
    lease: {
      token: `np_lease_${'B'.repeat(43)}`,
      expiresAt: new Date(Date.now() + 30000).toISOString()
    },
    template: { contentHash: hashJson(actionConfig), config: actionConfig },
    actions: [{ ...action, contractHash }],
    actionManifestHash: hashJson([{ name: action.name, contractHash }]),
    spaceContext: [],
    conversation: null,
    pendingOutcomes: []
  });
  expect(result.run.status).toBe('failed');
  expect(handler).not.toHaveBeenCalled();
  expect(
    calls.filter(call => call.url.endsWith('/steps') && call.body.steps[0].kind === 'action')
  ).toHaveLength(0);
  expect(calls.find(call => call.url.endsWith('/commit')).body.errorCode).toBe('timeout');
});
