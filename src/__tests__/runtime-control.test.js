const http = require('http');
const crypto = require('crypto');
const { serveAgents } = require('../index');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// Node 18's close waits for idle keep-alive connections; later versions close them.
const close = server =>
  new Promise(resolve => {
    server.close(resolve);
    server.closeIdleConnections();
  });
// A sync may join the acknowledgement that a previous change scheduled and return
// the state that request carried, so sync until the agent shows `state`, a few
// attempts at most, then sync once more to take up the acknowledgement this change
// scheduled before the test changes what the control API answers.
const confirm = async (server, state) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await server.syncControl()).toBe(true);
    const agent = server.agents.get('worker');
    if (Object.entries(state).every(([key, value]) => agent[key] === value)) break;
  }
  expect(server.agents.get('worker')).toMatchObject(state);
  expect(await server.syncControl()).toBe(true);
};

test('one runtime sync controls pause, resume and stop without changing local credentials', async () => {
  const runtimeKey = `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;
  let desired = { agent_id: 'worker', revision: 0, paused: false, stop_epoch: 0 };
  let lastManifest;
  let modelEntered;
  const modelStarted = new Promise(resolve => {
    modelEntered = resolve;
  });
  let releaseModel;
  const modelGate = new Promise(resolve => {
    releaseModel = resolve;
  });
  const control = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastManifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(req.headers.authorization).toBe(`Bearer ${runtimeKey}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pollAfterMs: 15000, agents: [desired] }));
  });
  const model = http.createServer(async (_req, res) => {
    modelEntered();
    await modelGate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        created: 1,
        model: 'local-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }
        ]
      })
    );
  });
  await Promise.all([listen(control), listen(model)]);
  const server = serveAgents({
    port: 0,
    apiKey: 'test-local-key',
    runtimeKey,
    runtimeEndpoint: `http://127.0.0.1:${control.address().port}`,
    agents: [
      {
        id: 'worker',
        mode: 'stateless',
        engines: { openai: 'local-model-key' },
        openaiBaseURL: `http://127.0.0.1:${model.address().port}/v1`,
        models: { openai: 'local-model' }
      }
    ]
  });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = path =>
    fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-local-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'chat', input: { prompt: 'hello' } })
    });
  try {
    await confirm(server, { controlRevision: 0, controlPaused: false });
    expect(lastManifest.agents).toHaveLength(1);
    expect(lastManifest.agents[0]).toMatchObject({
      id: 'worker',
      mode: 'stateless',
      model: 'local-model'
    });
    expect(JSON.stringify(lastManifest)).not.toContain('local-model-key');
    desired = { ...desired, revision: 1, paused: true };
    await confirm(server, { controlRevision: 1, controlPaused: true });
    expect((await post('/v1/agents/worker/invoke')).status).toBe(409);
    // The process-local enable route cannot override the Space pause.
    expect((await post('/v1/agents/worker/enable')).status).toBe(200);
    expect((await post('/v1/agents/worker/invoke')).status).toBe(409);
    desired = { ...desired, revision: 2, paused: false };
    await confirm(server, { controlRevision: 2, controlPaused: false });
    const pending = post('/v1/agents/worker/invoke');
    await modelStarted;
    desired = { ...desired, revision: 3, paused: true, stop_epoch: 1 };
    await confirm(server, { controlRevision: 3, controlStopEpoch: 1 });
    releaseModel();
    const cancelled = await pending;
    expect(cancelled.status).toBe(409);
    expect((await cancelled.json()).error.code).toBe('run_cancelled');
    expect(server.agents.get('worker')).toMatchObject({
      controlPaused: true,
      controlRevision: 3,
      controlStopEpoch: 1
    });
    expect(await server.syncControl()).toBe(true);
    expect(lastManifest.agents[0]).toMatchObject({ observedRevision: 3, observedStopEpoch: 1 });
    desired = { ...desired, revision: 4, stop_epoch: 2, blocked: true };
    await confirm(server, { controlRevision: 4, controlBlocked: true });
    expect(server.agents.get('worker').controlBlocked).toBe(true);
    desired = { agent_id: 'worker', revision: 4, paused: true, stop_epoch: 2 };
    await confirm(server, { controlBlocked: false, controlPaused: true });
    expect(server.agents.get('worker')).toMatchObject({
      controlBlocked: false,
      controlPaused: true
    });
  } finally {
    releaseModel();
    await server.shutdown();
    await Promise.all([close(control), close(model)]);
  }
});

test('a controlled runtime stays paused until its first successful sync', async () => {
  const key = `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;
  const control = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await listen(control);
  const server = serveAgents({
    port: 0,
    apiKey: 'test-local-key',
    runtimeKey: key,
    runtimeEndpoint: `http://127.0.0.1:${control.address().port}`,
    agents: [{ id: 'worker', mode: 'stateless', engines: { openai: 'local' } }]
  });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    expect(await server.syncControl()).toBe(false);
    expect(server.agents.get('worker').controlPaused).toBe(true);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/agents/worker/invoke`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-local-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'chat', input: { prompt: 'hello' } })
      }
    );
    expect(response.status).toBe(409);
  } finally {
    await server.shutdown();
    await close(control);
  }
});

test('a busy control API is retried before the regular poll', async () => {
  const key = `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;
  let requests = 0;
  const control = http.createServer((req, res) => {
    req.resume();
    requests++;
    if (requests === 1) {
      res.writeHead(409);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        pollAfterMs: 15000,
        agents: [{ agent_id: 'worker', revision: 0, paused: false, stop_epoch: 0 }]
      })
    );
  });
  await listen(control);
  const server = serveAgents({
    port: 0,
    apiKey: 'test-local-key',
    runtimeKey: key,
    runtimeEndpoint: `http://127.0.0.1:${control.address().port}`,
    agents: [{ id: 'worker', mode: 'stateless', engines: { openai: 'local' } }]
  });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error('control retry did not arrive'));
      }, 4000);
      const check = setInterval(() => {
        if (requests < 2 || server.agents.get('worker').controlPaused) return;
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }, 25);
    });
    expect(requests).toBeGreaterThanOrEqual(2);
  } finally {
    await server.shutdown();
    await close(control);
  }
});

test('a stale control connection pauses and cancels an active run', async () => {
  const key = `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;
  let unavailable = false;
  const control = http.createServer((req, res) => {
    req.resume();
    if (unavailable) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        pollAfterMs: 15000,
        agents: [{ agent_id: 'worker', revision: 0, paused: false, stop_epoch: 0 }]
      })
    );
  });
  let modelEntered;
  const started = new Promise(resolve => {
    modelEntered = resolve;
  });
  let releaseModel;
  const gate = new Promise(resolve => {
    releaseModel = resolve;
  });
  const model = http.createServer(async (_req, res) => {
    modelEntered();
    await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }] }));
  });
  await Promise.all([listen(control), listen(model)]);
  const server = serveAgents({
    port: 0,
    apiKey: 'test-local-key',
    runtimeKey: key,
    runtimeEndpoint: `http://127.0.0.1:${control.address().port}`,
    agents: [
      {
        id: 'worker',
        mode: 'stateless',
        engines: { openai: 'local-model-key' },
        openaiBaseURL: `http://127.0.0.1:${model.address().port}/v1`,
        models: { openai: 'local-model' }
      }
    ]
  });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await confirm(server, { controlRevision: 0, controlPaused: false });
    // The outage starts once state is confirmed; only the clock moves after the run starts.
    unavailable = true;
    const pending = fetch(`http://127.0.0.1:${server.address().port}/v1/agents/worker/invoke`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-local-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'chat', input: { prompt: 'hello' } })
    });
    await started;
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(realNow + 46000);
    try {
      expect(await server.syncControl()).toBe(false);
    } finally {
      now.mockRestore();
    }
    expect(server.agents.get('worker').controlPaused).toBe(true);
    releaseModel();
    const cancelled = await pending;
    expect(cancelled.status).toBe(409);
    expect((await cancelled.json()).error.code).toBe('run_cancelled');
  } finally {
    releaseModel();
    await server.shutdown();
    await Promise.all([close(control), close(model)]);
  }
});
