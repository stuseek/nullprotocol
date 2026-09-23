const http = require('http');
const { serveAgents, MemorySessionStore } = require('../index');

let modelServer;
let agentServer;
let agentUrl;
const requests = [];
const deliveredEvents = [];
const headers = { Authorization: 'Bearer local-test', 'Content-Type': 'application/json' };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function post(path, body) {
  const res = await global.fetch(agentUrl + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  modelServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(input);
    const isDecision = input.messages[0].content.includes('Analyze context and choose');
    const userCount = input.messages.filter(m => m.role === 'user').length;
    const content = isDecision
      ? JSON.stringify({
          action: 'wait',
          reasoning: 'Queue is quiet',
          confidence: 0.9,
          parameters: {}
        })
      : `reply:${userCount}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-completion',
        object: 'chat.completion',
        created: 1,
        model: input.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      })
    );
  });
  await listen(modelServer);
  const model = {
    engines: { openai: 'local-test' },
    openaiBaseURL: `http://127.0.0.1:${modelServer.address().port}/v1`,
    models: { openai: 'local-model' },
    retry: { maxRetries: 0 }
  };
  agentServer = serveAgents({
    port: 0,
    apiKey: 'local-test',
    store: new MemorySessionStore(),
    agents: [
      {
        id: 'worker',
        mode: 'stateless',
        ...model,
        telemetry: true,
        telemetryEndpoint: 'https://telemetry.example.test',
        telemetryKey: 'np_ingest_local_test',
        tools: [{ name: 'read_logs', description: 'Read logs' }],
        onToolCall: async () => ({ ok: true })
      },
      { id: 'companion', mode: 'stateful', ...model, basePrompt: 'You are a game merchant.' }
    ]
  });
  await new Promise(resolve => agentServer.on('listening', resolve));
  agentUrl = `http://127.0.0.1:${agentServer.address().port}`;
  agentServer.agents.get('worker').base.telemetry.send = async events => {
    deliveredEvents.push(...events);
    return { body: '{}' };
  };
});

afterAll(async () => {
  const telemetry = agentServer?.agents.get('worker')?.base.telemetry;
  if (telemetry) {
    await telemetry.destroy();
  }
  if (agentServer) {
    await close(agentServer);
  }
  if (modelServer) {
    await close(modelServer);
  }
});

test('stateless requests reach the provider without sharing history', async () => {
  const first = await post('/v1/agents/worker/invoke', { input: { prompt: 'prompt-marker-7f3' } });
  const second = await post('/v1/agents/worker/invoke', { input: { prompt: 'two' } });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.output.message).toBe('reply:1');
  expect(second.body.output.message).toBe('reply:1');
  expect(first.body.runId).not.toBe(second.body.runId);
  await agentServer.agents.get('worker').base.telemetry.flush();
  const firstRun = deliveredEvents.filter(event => event.runId === first.body.runId);
  expect(firstRun.map(event => event.event)).toEqual(['model_usage', 'ai_request', 'chat']);
  expect(firstRun.every(event => event.agentId === 'worker')).toBe(true);
  expect(firstRun[0].data).toMatchObject({ inputTokens: 10, outputTokens: 3 });
  expect(JSON.stringify(firstRun)).not.toContain('prompt-marker-7f3');
  expect(JSON.stringify(firstRun)).not.toContain('reply:');
});

test('stateful session persists history and keeps context out of system text', async () => {
  const created = await post('/v1/agents/companion/sessions', { context: { shop: 'forest' } });
  expect(created.status).toBe(201);
  const path = `/v1/agents/companion/sessions/${created.body.sessionId}/messages`;
  const first = await post(path, { prompt: 'hello' });
  const second = await post(path, { prompt: 'again' });
  expect(first.body.output.message).toBe('reply:1');
  expect(second.body.output.message).toBe('reply:2');
  const last = requests.at(-1);
  expect(last.messages[0].content).not.toContain('forest');
  expect(last.messages.at(-1).content).toContain('forest');
  expect(last.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
});

test('decide with configured tools receives a plain model response', async () => {
  const response = await post('/v1/agents/worker/invoke', {
    operation: 'decide',
    input: { context: { queue: 0 }, actions: ['wait', 'inspect'] }
  });
  expect(response.status).toBe(200);
  expect(response.body.output).toMatchObject({ success: true, action: 'wait' });
  expect(requests.at(-1).tools).toBeUndefined();
});
