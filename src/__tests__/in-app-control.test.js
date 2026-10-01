const crypto = require('crypto');
const http = require('http');
const https = require('https');
const NullProtocol = require('../index');
const { serveAgents } = require('../agent-server');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server =>
  new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
const runtimeKey = () => `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;

// A control API that answers each sync with the desired state of every reported agent.
async function controlApi() {
  const desired = new Map();
  const syncs = [];
  let status = 200;
  let gate = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    syncs.push(body);
    await gate;
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        agents: body.agents.map(agent => ({
          agent_id: agent.id,
          revision: 0,
          paused: false,
          stop_epoch: 0,
          ...desired.get(agent.id)
        }))
      })
    );
  });
  await listen(server);
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    syncs,
    set: (id, state) => desired.set(id, { ...desired.get(id), ...state }),
    fail: code => (status = code),
    // Holds sync answers until the returned function is called.
    hold: () => {
      let release;
      gate = new Promise(resolve => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
    close: () => close(server)
  };
}

// An OpenAI-compatible model server; `reply` decides each answer and may wait.
async function modelApi(reply = async () => ({ content: '{"orderId": 42}' })) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const request = { body, aborted: false };
    res.on('close', () => {
      if (!res.writableEnded) request.aborted = true;
    });
    requests.push(request);
    const answer = await reply(body, requests.length, res);
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...answer } }]
      })
    );
  });
  await listen(server);
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => close(server)
  };
}

function client(agentId, control, model, key, extra = {}) {
  return new NullProtocol({
    agentId,
    provider: 'openai-compatible',
    baseURL: model.baseURL,
    model: 'local-model',
    runtimeKey: key,
    runtimeEndpoint: control.endpoint,
    retry: { maxRetries: 0 },
    configFile: false,
    ...extra
  });
}

// Waits for a sync in progress, then runs a fresh one that reports the current agents.
const syncNow = async ai => {
  await ai.control.link.syncing;
  return ai.control.link.sync();
};

const until = async check => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('control of clients in an application', () => {
  let control;
  let model;
  let key;
  const opened = [];
  beforeEach(async () => {
    control = await controlApi();
    model = await modelApi();
    key = runtimeKey();
  });
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(ai => ai.close()));
    await Promise.all([control.close(), model.close()]);
  });
  const open = (id, extra) => {
    const ai = client(id, control, model, key, extra);
    opened.push(ai);
    return ai;
  };

  test('a paused agent makes no model request while another agent keeps working', async () => {
    const support = open('support');
    const ops = open('ops');
    expect((await support.extract('Order 42', { orderId: 'number' })).success).toBe(true);
    expect((await ops.extract('Order 42', { orderId: 'number' })).success).toBe(true);
    // One connection reports both agents in one manifest.
    expect(new Set(control.syncs.map(sync => sync.instanceId)).size).toBe(1);
    expect(
      control.syncs
        .at(-1)
        .agents.map(agent => agent.id)
        .sort()
    ).toEqual(['ops', 'support']);

    control.set('ops', { paused: true, revision: 1 });
    await syncNow(ops);
    const before = model.requests.length;
    expect(await ops.extract('Order 42', { orderId: 'number' })).toMatchObject({
      success: false,
      errorCode: 'agent_paused'
    });
    expect(model.requests).toHaveLength(before);
    expect((await support.extract('Order 42', { orderId: 'number' })).success).toBe(true);

    control.set('ops', { paused: false, revision: 2 });
    await syncNow(ops);
    expect((await ops.extract('Order 42', { orderId: 'number' })).success).toBe(true);
  });

  test('a paused stream raises the control error when read', async () => {
    control.set('ops', { paused: true, revision: 1 });
    const ops = open('ops');
    const stream = await ops.chat('hi', { stream: true });
    await expect(
      (async () => {
        for await (const chunk of stream) expect(chunk).toBeUndefined();
      })()
    ).rejects.toMatchObject({ name: 'ControlError', code: 'agent_paused' });
    expect(model.requests).toHaveLength(0);
  });

  test('a client closed while waiting for its first state does not call the model', async () => {
    const support = open('support');
    await support.chat('hi');
    const release = control.hold();
    const ops = open('ops');
    const pending = ops.chat('hi');
    await new Promise(resolve => setTimeout(resolve, 50));
    await ops.close();
    release();
    expect(await pending).toMatchObject({ success: false, errorCode: 'control_closed' });
    expect(model.requests).toHaveLength(1);
  });

  test('a stream closed before it is read leaves no active run', async () => {
    const ops = open('ops');
    await ops.chat('hi');
    const stream = await ops.chat('hi', { stream: true });
    await stream.return();
    await syncNow(ops);
    expect(control.syncs.at(-1).agents).toEqual([expect.objectContaining({ activeRuns: 0 })]);
    expect(model.requests).toHaveLength(1);
  });

  test('a pause between chat() and the first read blocks the stream', async () => {
    const ops = open('ops');
    await ops.chat('hi');
    const stream = await ops.chat('hi', { stream: true });
    control.set('ops', { paused: true, revision: 1 });
    await syncNow(ops);
    await expect(stream.next()).rejects.toMatchObject({
      name: 'ControlError',
      code: 'agent_paused'
    });
    expect(model.requests).toHaveLength(1);
  });

  test('a new process starts paused when the cabinet has paused the agent', async () => {
    control.set('ops', { paused: true, revision: 4 });
    const ops = open('ops');
    expect(await ops.chat('hi')).toMatchObject({ success: false, errorCode: 'agent_paused' });
    expect(model.requests).toHaveLength(0);
  });

  test('during an outage a running agent keeps working', async () => {
    const ops = open('ops');
    expect((await ops.chat('hi')).success).toBe(true);
    control.fail(503);
    expect(await syncNow(ops)).toBe(false);
    expect((await ops.chat('hi')).success).toBe(true);
  });

  test('during an outage a paused agent stays paused', async () => {
    const ops = open('ops');
    control.set('ops', { paused: true, revision: 1 });
    expect(await ops.chat('hi')).toMatchObject({ errorCode: 'agent_paused' });
    control.fail(503);
    expect(await syncNow(ops)).toBe(false);
    expect(await ops.chat('hi')).toMatchObject({ errorCode: 'agent_paused' });
    expect(model.requests).toHaveLength(0);
  });

  test('a refused runtime key blocks new operations with a control error', async () => {
    control.fail(401);
    const ops = open('ops');
    expect(await ops.chat('hi')).toMatchObject({ success: false, errorCode: 'control_rejected' });
    expect(model.requests).toHaveLength(0);
  });

  test('closing one client leaves the other under control', async () => {
    const support = open('support');
    const ops = open('ops');
    await support.chat('hi');
    await ops.chat('hi');
    await support.close();
    expect(await support.chat('hi')).toMatchObject({ errorCode: 'control_closed' });
    control.set('ops', { paused: true, revision: 1 });
    await syncNow(ops);
    expect(control.syncs.at(-1).agents.map(agent => agent.id)).toEqual(['ops']);
    expect(await ops.chat('hi')).toMatchObject({ errorCode: 'agent_paused' });
  });

  test('clients with the same ID are one manifest entry, and history makes it stateful', async () => {
    const first = open('ops', { trackHistory: true });
    const second = open('ops', { trackHistory: true });
    await Promise.all([first.chat('hi'), second.chat('hi')]);
    const reported = control.syncs.at(-1).agents;
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ id: 'ops', mode: 'stateful', model: 'local-model' });
  });

  test('active runs of clients with the same ID are reported together', async () => {
    let release;
    const gate = new Promise(resolve => (release = resolve));
    await model.close();
    model = await modelApi(async () => {
      await gate;
      return { content: 'ok' };
    });
    const first = open('ops');
    const second = open('ops');
    const running = [first.chat('hi'), second.chat('hi')];
    await until(() => model.requests.length === 2);
    await syncNow(first);
    expect(control.syncs.at(-1).agents).toEqual([
      expect.objectContaining({ id: 'ops', activeRuns: 2 })
    ]);
    release();
    await Promise.all(running);
  });

  test('closing a serveAgents service does not stop control of clients on the same key', async () => {
    const ops = open('ops');
    await ops.chat('hi');
    const server = serveAgents({
      port: 0,
      apiKey: 'http-access-key',
      runtimeKey: key,
      runtimeEndpoint: control.endpoint,
      agents: [
        {
          id: 'worker',
          mode: 'stateless',
          provider: 'openai-compatible',
          baseURL: model.baseURL,
          model: 'local-model'
        }
      ]
    });
    await new Promise(resolve => server.once('listening', resolve));
    await until(() => control.syncs.at(-1).agents.length === 2);
    await server.shutdown({ drainTimeoutMs: 100, cancelTimeoutMs: 100 });
    control.set('ops', { paused: true, revision: 1 });
    await syncNow(ops);
    expect(control.syncs.at(-1).agents.map(agent => agent.id)).toEqual(['ops']);
    expect(await ops.chat('hi')).toMatchObject({ errorCode: 'agent_paused' });
  });
});

describe('stop', () => {
  let control;
  let key;
  beforeEach(async () => {
    control = await controlApi();
    key = runtimeKey();
  });
  afterEach(() => control.close());
  const stop = async ai => {
    control.set(ai.agentId, { paused: true, stop_epoch: 1, revision: 1 });
    await syncNow(ai);
  };

  test('cancels a running request and starts no repair', async () => {
    const model = await modelApi(async (_body, count) => {
      if (count === 1) {
        await stop(ops);
        return { content: 'not json' };
      }
      return { content: '{"orderId": 42}' };
    });
    const ops = client('ops', control, model, key);
    try {
      const result = await ops.extract('Order 42', { orderId: 'number' });
      expect(result).toMatchObject({ success: false, errorCode: 'run_cancelled' });
      expect(model.requests).toHaveLength(1);
    } finally {
      await ops.close();
      await model.close();
    }
  });

  test('a stopped request and its operation are both reported as aborted', async () => {
    const model = await modelApi(async () => {
      await stop(ops);
      return { content: '{"orderId": 42}' };
    });
    const ops = client('ops', control, model, key, {
      telemetry: true,
      telemetryKey: 'test',
      telemetryEndpoint: 'https://telemetry.example.test'
    });
    try {
      await ops.extract('Order 42', { orderId: 'number' });
      const events = ops.telemetry.queue.map(event => ({ event: event.event, ...event.data }));
      expect(events).toEqual([
        expect.objectContaining({
          event: 'ai_request',
          success: false,
          errorCode: 'aborted',
          model: 'local-model'
        }),
        expect.objectContaining({ event: 'extract', success: false, errorCode: 'aborted' })
      ]);
    } finally {
      ops.telemetry.enabled = false;
      await ops.close();
      await model.close();
    }
  });

  test('aborts a stream mid-way', async () => {
    const model = await modelApi(async (_body, _count, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}\n\n`);
      await stop(ops);
      // Never finishes on its own.
    });
    const ops = client('ops', control, model, key);
    try {
      const chunks = [];
      const stream = await ops.chat('hi', { stream: true });
      await expect(
        (async () => {
          for await (const chunk of stream) chunks.push(chunk);
        })()
      ).rejects.toMatchObject({ name: 'AbortError', code: 'run_cancelled' });
      expect(chunks).toEqual(['part']);
      await until(() => model.requests[0].aborted);
    } finally {
      await ops.close();
      await model.close();
    }
  });

  test('a tool callback gets the abort and no further model round starts', async () => {
    const model = await modelApi(async () => ({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"id":42}' } }
      ]
    }));
    const ops = client('ops', control, model, key);
    let callbackAborted = false;
    try {
      const result = await ops.chat('Look up 42', {
        tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
        onToolCall: async (_name, _params, context) => {
          const aborted = new Promise(resolve =>
            context.signal.addEventListener('abort', resolve, { once: true })
          );
          await stop(ops);
          await aborted;
          callbackAborted = true;
          return { found: true };
        }
      });
      expect(callbackAborted).toBe(true);
      expect(result).toMatchObject({ success: false });
      expect(model.requests).toHaveLength(1);
    } finally {
      await ops.close();
      await model.close();
    }
  });
});

describe('opting in', () => {
  test('a runtime key in the environment alone does not turn control on', () => {
    process.env.NULLPROTOCOL_RUNTIME_KEY = runtimeKey();
    process.env.NULLPROTOCOL_RUNTIME_ENDPOINT = 'http://127.0.0.1:9';
    try {
      const ai = new NullProtocol({
        provider: 'openai-compatible',
        baseURL: 'http://127.0.0.1:9/v1',
        model: 'm',
        configFile: false
      });
      expect(ai.control).toBeNull();
    } finally {
      delete process.env.NULLPROTOCOL_RUNTIME_KEY;
      delete process.env.NULLPROTOCOL_RUNTIME_ENDPOINT;
    }
  });

  test('control needs an explicit agentId', () => {
    expect(
      () =>
        new NullProtocol({
          provider: 'openai-compatible',
          baseURL: 'http://127.0.0.1:9/v1',
          model: 'm',
          runtimeKey: runtimeKey(),
          runtimeEndpoint: 'http://127.0.0.1:9',
          configFile: false
        })
    ).toThrow('Runtime control requires agentId');
  });
});

test('telemetry events carry each client agent ID, and a refusal is one event', async () => {
  const events = [];
  const collector = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    events.push(...JSON.parse(Buffer.concat(chunks).toString('utf8')).events);
    res.end('{}');
  });
  await listen(collector);
  const model = await modelApi();
  // Real HTTP; only TLS is skipped by sending the https request over plain http.
  const requestSpy = jest
    .spyOn(https, 'request')
    .mockImplementation((options, onResponse) =>
      http.request(
        { ...options, hostname: '127.0.0.1', port: collector.address().port },
        onResponse
      )
    );
  const telemetry = {
    telemetry: true,
    telemetryEndpoint: 'https://telemetry.test',
    telemetryKey: 'ingest-key'
  };
  const control = await controlApi();
  control.set('paused', { paused: true, revision: 1 });
  const make = agentId =>
    new NullProtocol({
      agentId,
      provider: 'openai-compatible',
      baseURL: model.baseURL,
      model: 'local-model',
      configFile: false,
      ...telemetry
    });
  const support = make('support');
  const ops = make('ops');
  const paused = new NullProtocol({
    agentId: 'paused',
    provider: 'openai-compatible',
    baseURL: model.baseURL,
    model: 'local-model',
    configFile: false,
    runtimeKey: runtimeKey(),
    runtimeEndpoint: control.endpoint,
    ...telemetry
  });
  try {
    await support.extract('Order 42', { orderId: 'number' });
    await ops.extract('Order 42', { orderId: 'number' });
    // The refusal waits for the first control state, which arrives after a delay.
    const release = control.hold();
    setTimeout(release, 60);
    await paused.extract('Order 42', { orderId: 'number' });
    await Promise.all([support.close(), ops.close(), paused.close()]);
    const extracts = events.filter(event => event.event === 'extract');
    expect(extracts.map(event => event.agentId).sort()).toEqual(['ops', 'paused', 'support']);
    const refused = events.filter(event => event.agentId === 'paused');
    expect(refused).toEqual([
      expect.objectContaining({
        event: 'extract',
        data: expect.objectContaining({ success: false, errorCode: 'agent_paused' })
      })
    ]);
    expect(refused[0].data.duration).toBeGreaterThanOrEqual(50);
    expect(model.requests).toHaveLength(2);
  } finally {
    requestSpy.mockRestore();
    await Promise.all([close(collector), model.close(), control.close()]);
  }
});
