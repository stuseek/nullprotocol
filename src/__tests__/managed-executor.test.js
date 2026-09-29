const { ManagedExecutor } = require('../managed-executor');
const { hashJson, actionContractHash } = require('../managed-canonical');
const { PlatformError } = require('../managed-http');

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

describe('executor lifetime', () => {
  // Registration answers with `register`; a claim waits until it is aborted.
  function lifetimeExecutor(register) {
    return new ManagedExecutor({
      executorKey,
      agentIds: [agentId],
      credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/v1/space')) {
          return new globalThis.Response(JSON.stringify({ space: { slug: 'demo' } }));
        }
        if (url.endsWith('/claim')) {
          return new Promise((resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
          });
        }
        if (options.method === 'DELETE') return new globalThis.Response(null, { status: 204 });
        const { status, body } = register();
        return new globalThis.Response(JSON.stringify(body), { status });
      }
    });
  }
  const accepted = () => ({ status: 200, body: { executor: { instanceId: 'x' } } });

  test('stop resolves closed after deregistering', async () => {
    const executor = await lifetimeExecutor(accepted).start();
    await executor.stop();
    await expect(executor.closed).resolves.toEqual({ reason: 'stopped' });
  });

  test.each([
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'platform_unavailable']
  ])('a %s heartbeat closes the executor', async (status, error, reason) => {
    let register = accepted;
    const executor = await lifetimeExecutor(() => register()).start();
    register = () => ({ status, body: { error } });
    await executor._heartbeat();
    await expect(executor.closed).resolves.toEqual({ reason });
    expect(executor.running).toBe(false);
    await executor.stop();
  });

  test('a failed first registration rejects start and leaves nothing to wait on', async () => {
    const executor = lifetimeExecutor(() => ({ status: 401, body: { error: 'unauthorized' } }));
    await expect(executor.start()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(executor.closed).toBeNull();
  });
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
        return new globalThis.Response(
          JSON.stringify({
            spaceContext: [],
            agentContext: [{ key: 'region', value: 'EU', version: 'v1' }],
            agentMemory: [{ id: 'memory-1', text: 'Prefers brief replies.' }],
            disabledActions: []
          })
        );
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
      conversation: {
        id: conversationId,
        version: 0,
        messages: [],
        facts: [{ id: 'fact-1', value: { order: '123' }, sourceSeqs: [1] }],
        summary: { content: 'The customer asked about order 123.', coversToSeq: 1 }
      },
      agentContext: [{ key: 'region', value: 'EU', version: 'v1' }],
      agentMemory: [{ id: 'memory-1', text: 'Prefers brief replies.' }],
      pendingOutcomes: [],
      ...(mode === 'read'
        ? {
            unrecordedOutcomes: [
              { runId: otherAgentId, callId: 'older-call', name: 'refund', status: 'succeeded' }
            ]
          }
        : {})
    });
    expect(result.run.status).toBe(failSecond ? 'failed' : 'succeeded');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].idempotencyKey).toMatch(new RegExp(`^${runId}:`));
    expect(handler.mock.calls[0][1].agentContext).toEqual([
      { key: 'region', value: 'EU', version: 'v1' }
    ]);
    expect(modelRequests[0].messages.at(-1).content).toContain('conversationFacts');
    expect(modelRequests[0].messages.at(-1).content).toContain('Prefers brief replies.');
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
    } else {
      expect(commits[0].conversation.append[1].content.actionOutcomes).toEqual([
        { runId: otherAgentId, callId: 'older-call', name: 'refund', status: 'succeeded' }
      ]);
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

test('a rejected memory commit keeps the run result and write history', async () => {
  const errors = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    onError: code => errors.push(code)
  });
  executor._commitWithRetry = jest
    .fn()
    .mockRejectedValueOnce(
      new PlatformError('quota_exceeded', 409, { resource: 'conversationFacts' })
    )
    .mockResolvedValueOnce({ run: { status: 'succeeded' } });
  const body = {
    status: 'succeeded',
    output: { text: 'Refunded' },
    conversation: {
      id: conversationId,
      expectedVersion: 4,
      append: [{ role: 'assistant', content: { actionOutcomes: [{ name: 'refund' }] } }],
      memory: { factsAdd: [], summary: { content: 'Summary', coversToSeq: 2 } }
    }
  };
  await expect(
    executor._commitWithMemoryFallback(runId, 'lease', body, () => Date.now() + 30000)
  ).resolves.toMatchObject({ run: { status: 'succeeded' } });
  expect(executor._commitWithRetry).toHaveBeenCalledTimes(2);
  const fallback = executor._commitWithRetry.mock.calls[1][2];
  expect(fallback.conversation.memory).toBeUndefined();
  expect(fallback.conversation.append).toEqual(body.conversation.append);
  expect(errors).toEqual(['compaction_not_saved']);
});

test('storage quota failure terminates the run instead of silently dropping its history', async () => {
  const errors = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    onError: code => errors.push(code)
  });
  executor._commitWithRetry = jest
    .fn()
    .mockRejectedValueOnce(new PlatformError('quota_exceeded', 409, { resource: 'storageBytes' }))
    .mockRejectedValueOnce(new PlatformError('quota_exceeded', 409, { resource: 'storageBytes' }))
    .mockResolvedValueOnce({ run: { status: 'failed', errorCode: 'quota_exceeded' } });
  const result = await executor._commitWithMemoryFallback(
    runId,
    'lease',
    {
      status: 'succeeded',
      errorCode: null,
      output: { text: 'Refunded' },
      usage: { inputTokens: 10, outputTokens: 2 },
      conversation: {
        id: conversationId,
        expectedVersion: 4,
        append: [{ role: 'assistant', content: { actionOutcomes: [{ name: 'refund' }] } }],
        memory: { factsAdd: [], summary: { content: 'Summary', coversToSeq: 2 } }
      }
    },
    () => Date.now() + 30000
  );
  expect(result.run).toEqual({ status: 'failed', errorCode: 'quota_exceeded' });
  expect(executor._commitWithRetry).toHaveBeenCalledTimes(3);
  expect(executor._commitWithRetry.mock.calls[1][2].conversation.memory).toBeUndefined();
  expect(executor._commitWithRetry.mock.calls[2][2]).toEqual({
    status: 'failed',
    errorCode: 'quota_exceeded',
    output: null,
    usage: { inputTokens: 10, outputTokens: 2 },
    conversation: null
  });
  expect(errors).toEqual(['quota_exceeded']);
});

test('memory capacity is traced while the agent still answers from its current window', async () => {
  const errors = [];
  const requests = [];
  const steps = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    onError: code => errors.push(code),
    modelFetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const compacting = request.messages[0].content.startsWith('Compact the supplied');
      return new globalThis.Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: compacting
                  ? JSON.stringify({
                      facts: [{ value: { id: 'new' }, sourceSeqs: [1] }],
                      summary: 'Earlier discussion.'
                    })
                  : 'I can answer from the recent messages.'
              }
            }
          ]
        })
      );
    }
  });
  executor._sources = jest.fn(async () => ({
    messages: Array.from({ length: 16 }, (_, index) => ({
      seq: index + 1,
      role: index % 2 ? 'assistant' : 'user',
      content: `history ${index + 1}`
    }))
  }));
  executor._stepWithRetry = jest.fn(async (_run, _token, step) => {
    steps.push(step);
  });
  executor._commitWithMemoryFallback = jest.fn(async (_run, _token, body) => ({ run: body }));
  const result = await executor._processActionJob(
    {
      run: {
        id: runId,
        agentId,
        input: 'What happened recently?',
        deadlineAt: new Date(Date.now() + 180000).toISOString()
      },
      template: { config },
      actions: [],
      actionManifestHash: hashJson([]),
      spaceContext: [],
      conversation: {
        id: conversationId,
        version: 1,
        messages: Array.from({ length: 32 }, (_, index) => ({
          seq: index + 1,
          role: index % 2 ? 'assistant' : 'user',
          content: `history ${index + 1}`
        })),
        facts: Array.from({ length: 100 }, (_, index) => ({
          id: `fact-${index}`,
          value: { text: 'x'.repeat(1050), index },
          sourceSeqs: [index + 1]
        }))
      }
    },
    `np_lease_${'B'.repeat(43)}`,
    executor.credentials.localModel,
    new AbortController(),
    { expiresAt: () => Date.now() + 30000, lost: () => false, cancelled: () => false }
  );
  expect(result.run.status).toBe('succeeded');
  expect(result.run.output.text).toBe('I can answer from the recent messages.');
  expect(result.run.conversation.memory).toBeUndefined();
  expect(steps).toContainEqual(
    expect.objectContaining({
      kind: 'compaction',
      status: 'failed',
      payload: expect.objectContaining({ errorCode: 'memory_capacity' })
    })
  );
  expect(requests.at(-1).messages.at(-1).content).toContain('memoryIncomplete');
  expect(requests).toHaveLength(1);
  expect(errors).toEqual(['memory_capacity']);
});

test('invalid compaction from a local model does not prevent a reply', async () => {
  const steps = [];
  const errors = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    onError: code => errors.push(code),
    modelFetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const compacting = request.messages[0].content.startsWith('Compact the supplied');
      return new globalThis.Response(
        JSON.stringify({
          choices: [{ message: { content: compacting ? 'not JSON' : 'Recent answer.' } }]
        })
      );
    }
  });
  executor._sources = jest.fn(async () => ({
    messages: Array.from({ length: 16 }, (_, index) => ({
      seq: index + 1,
      role: index % 2 ? 'assistant' : 'user',
      content: `history ${index + 1}`
    }))
  }));
  executor._stepWithRetry = jest.fn(async (_run, _token, step) => steps.push(step));
  executor._commitWithMemoryFallback = jest.fn(async (_run, _token, body) => ({ run: body }));
  const result = await executor._processActionJob(
    {
      run: {
        id: runId,
        agentId,
        input: 'Question',
        deadlineAt: new Date(Date.now() + 180000).toISOString()
      },
      template: { config },
      actions: [],
      actionManifestHash: hashJson([]),
      spaceContext: [],
      conversation: {
        id: conversationId,
        version: 1,
        messages: Array.from({ length: 32 }, (_, index) => ({
          seq: index + 1,
          role: index % 2 ? 'assistant' : 'user',
          content: `history ${index + 1}`
        }))
      }
    },
    `np_lease_${'B'.repeat(43)}`,
    executor.credentials.localModel,
    new AbortController(),
    { expiresAt: () => Date.now() + 30000, lost: () => false, cancelled: () => false }
  );
  expect(result.run.status).toBe('succeeded');
  expect(result.run.output.text).toBe('Recent answer.');
  expect(steps).toContainEqual(
    expect.objectContaining({
      kind: 'compaction',
      status: 'failed',
      payload: expect.objectContaining({ errorCode: 'invalid_compaction' })
    })
  );
  expect(errors).toEqual(['invalid_compaction']);
});

test('compaction stops at its time budget and leaves time for the answer', async () => {
  const initialNow = Date.now();
  let clock = initialNow;
  const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    const steps = [];
    const executor = new ManagedExecutor({
      executorKey,
      agentIds: [agentId],
      credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
      modelFetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const compacting = request.messages[0].content.startsWith('Compact the supplied');
        if (compacting) clock += 4000;
        return new globalThis.Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: compacting
                    ? JSON.stringify({ facts: [], summary: 'Earlier discussion.' })
                    : 'Answered.'
                }
              }
            ]
          })
        );
      }
    });
    executor._sources = jest.fn(async () => ({
      messages: Array.from({ length: 16 }, (_, index) => ({
        seq: index + 1,
        role: index % 2 ? 'assistant' : 'user',
        content: `history ${index + 1}`
      }))
    }));
    executor._context = jest.fn(async () => ({
      spaceContext: [],
      agentContext: [],
      agentMemory: [],
      disabledActions: []
    }));
    executor._stepWithRetry = jest.fn(async (_run, _token, step) => steps.push(step));
    executor._commitWithMemoryFallback = jest.fn(async (_run, _token, body) => ({ run: body }));
    const result = await executor._processActionJob(
      {
        run: {
          id: runId,
          agentId,
          input: 'Question',
          deadlineAt: new Date(initialNow + 15000).toISOString()
        },
        template: { config },
        actions: [],
        actionManifestHash: hashJson([]),
        spaceContext: [],
        conversation: {
          id: conversationId,
          version: 1,
          messages: Array.from({ length: 32 }, (_, index) => ({
            seq: index + 1,
            role: index % 2 ? 'assistant' : 'user',
            content: `history ${index + 1}`
          }))
        }
      },
      `np_lease_${'B'.repeat(43)}`,
      executor.credentials.localModel,
      new AbortController(),
      { expiresAt: () => clock + 30000, lost: () => false, cancelled: () => false }
    );
    expect(result.run.status).toBe('succeeded');
    expect(result.run.output.text).toBe('Answered.');
    expect(executor._sources).toHaveBeenCalledTimes(1);
    expect(steps).toContainEqual(
      expect.objectContaining({
        kind: 'compaction',
        status: 'failed',
        payload: expect.objectContaining({ errorCode: 'compaction_backlog' })
      })
    );
    expect(result.run.conversation.memory.summary.coversToSeq).toBe(16);
  } finally {
    now.mockRestore();
  }
});

test('an oversized fact set is bounded, traced, and cannot authorize a write', async () => {
  const action = {
    name: 'refund',
    description: 'Refund an order',
    effect: 'write',
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { type: 'object', properties: { receipt: { type: 'string' } }, required: ['receipt'] }
  };
  const contractHash = actionContractHash(action);
  const actionConfig = { ...config, actions: [action] };
  const handler = jest.fn(async () => ({ receipt: 'R-1' }));
  const requests = [];
  const steps = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: { localModel: { provider: 'local', baseURL: 'http://localhost:11434/v1' } },
    actions: [{ ...action, handler }],
    modelFetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new globalThis.Response(
        JSON.stringify({ choices: [{ message: { content: 'I need more history first.' } }] })
      );
    }
  });
  executor._stepWithRetry = jest.fn(async (_run, _token, step) => steps.push(step));
  executor._commitWithMemoryFallback = jest.fn(async (_run, _token, body) => ({ run: body }));
  const job = {
    run: {
      id: runId,
      agentId,
      input: 'Refund the order',
      deadlineAt: new Date(Date.now() + 180000).toISOString()
    },
    template: { config: actionConfig },
    actions: [{ ...action, contractHash }],
    actionManifestHash: hashJson([{ name: action.name, contractHash }]),
    spaceContext: [],
    conversation: {
      id: conversationId,
      version: 1,
      messages: [],
      facts: Array.from({ length: 100 }, (_, index) => ({
        id: `fact-${index}`,
        value: { index, text: 'x'.repeat(1900) },
        sourceSeqs: [index + 1]
      }))
    }
  };
  const result = await executor._processActionJob(
    job,
    `np_lease_${'B'.repeat(43)}`,
    executor.credentials.localModel,
    new AbortController(),
    { expiresAt: () => Date.now() + 30000, lost: () => false, cancelled: () => false }
  );
  expect(result.run.status).toBe('succeeded');
  expect(handler).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toBeUndefined();
  const prompt = requests[0].messages.at(-1).content;
  expect(prompt).toContain('"index":99');
  expect(prompt).not.toContain('"index":0');
  expect(prompt).toContain('memoryIncomplete');
  expect(steps).toContainEqual(
    expect.objectContaining({
      kind: 'context',
      status: 'succeeded',
      payload: expect.objectContaining({
        truncated: expect.objectContaining({
          facts: expect.any(Number),
          actions: ['refund']
        })
      })
    })
  );
  expect(job.memoryIncomplete).toBe(true);
});

test.each([
  ['read', 'native'],
  ['write', 'native'],
  ['read', 'text'],
  ['write', 'text']
])('large %s results do not overflow a later %s-protocol model turn', async (effect, protocol) => {
  const text = protocol === 'text';
  const action = {
    name: 'searchOrders',
    description: 'Search orders',
    effect,
    input: { type: 'object', properties: {}, additionalProperties: false },
    output: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
    maxResultBytes: 65536
  };
  const contractHash = actionContractHash(action);
  const actionConfig = { ...config, actions: [action] };
  const requests = [];
  const steps = [];
  const executor = new ManagedExecutor({
    executorKey,
    agentIds: [agentId],
    credentials: {
      localModel: {
        provider: 'local',
        baseURL: 'http://localhost:11434/v1',
        ...(text ? { toolCalls: false } : {})
      }
    },
    actions: [{ ...action, handler: async () => ({ data: 'x'.repeat(60000) }) }],
    modelFetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new globalThis.Response(
        JSON.stringify({
          choices: [
            {
              message: text
                ? {
                    content:
                      requests.length === 1
                        ? '{"action":"searchOrders","parameters":{}}'
                        : '{"answer":"Done."}'
                  }
                : requests.length === 1
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: 'call-1',
                          type: 'function',
                          function: { name: 'searchOrders', arguments: '{}' }
                        }
                      ]
                    }
                  : { content: 'Done.' }
            }
          ]
        })
      );
    }
  });
  executor._lease = jest.fn(async () => ({ expiresAt: new Date(Date.now() + 30000) }));
  executor._context = jest.fn(async () => ({
    spaceContext: [],
    agentContext: [],
    agentMemory: [],
    disabledActions: []
  }));
  executor._stepWithRetry = jest.fn(async (_run, _token, step) => steps.push(step));
  executor._commitWithMemoryFallback = jest.fn(async (_run, _token, body) => ({ run: body }));
  const result = await executor._processActionJob(
    {
      run: {
        id: runId,
        agentId,
        input: 'Search orders',
        deadlineAt: new Date(Date.now() + 180000).toISOString()
      },
      template: { config: actionConfig },
      actions: [{ ...action, contractHash }],
      actionManifestHash: hashJson([{ name: action.name, contractHash }]),
      spaceContext: [],
      conversation: {
        id: conversationId,
        version: 1,
        messages: [],
        facts: Array.from({ length: 70 }, (_, index) => ({
          id: `fact-${index}`,
          value: { data: 'f'.repeat(1300) },
          sourceSeqs: [index + 1]
        }))
      }
    },
    `np_lease_${'B'.repeat(43)}`,
    executor.credentials.localModel,
    new AbortController(),
    { expiresAt: () => Date.now() + 30000, lost: () => false, cancelled: () => false }
  );
  expect(result.run.status).toBe('succeeded');
  expect(requests).toHaveLength(2);
  const resultMessage = text
    ? requests[1].messages.find(message => message.content?.startsWith('Action result:'))
    : requests[1].messages.find(message => message.role === 'tool');
  const toolMessage = resultMessage.content;
  expect(toolMessage).toContain(
    effect === 'write' ? '"status":"succeeded"' : 'result_too_large_for_context'
  );
  expect(steps).toContainEqual(
    expect.objectContaining({
      kind: 'context',
      payload: expect.objectContaining({
        truncated: expect.objectContaining({ toolResults: 1 })
      })
    })
  );
});
