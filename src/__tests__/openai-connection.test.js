const crypto = require('crypto');
const http = require('http');
const https = require('https');
const OpenAI = require('openai');
const { connectOpenAI } = require('../../openai');
const { controlLink } = require('../runtime-control');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server =>
  new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });
const until = async check => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
};

// An OpenAI-compatible server. `handle` answers each request; every request
// records its body and whether the client closed the connection before the end.
let handle;
const requests = [];
const model = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = { body: JSON.parse(body), closedEarly: false };
  res.on('close', () => {
    if (!res.writableEnded) request.closedEarly = true;
  });
  requests.push(request);
  await handle(res, request.body);
});
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const sse = (res, chunks, { end = true } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (end) res.end('data: [DONE]\n\n');
};

// Where telemetry goes: real HTTP; only TLS is skipped.
const events = [];
const collector = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  events.push(...JSON.parse(body).events);
  res.end('{}');
});
let requestSpy;

// A control API answering each sync with the desired state of every agent.
const desired = new Map();
const syncs = [];
let gate = null;
const control = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const manifest = JSON.parse(body);
  syncs.push(manifest);
  await gate;
  json(res, 200, {
    agents: manifest.agents.map(agent => ({
      agent_id: agent.id,
      revision: 0,
      paused: false,
      stop_epoch: 0,
      ...desired.get(agent.id)
    }))
  });
});

beforeAll(async () => {
  await Promise.all([listen(model), listen(collector), listen(control)]);
  requestSpy = jest
    .spyOn(https, 'request')
    .mockImplementation((options, onResponse) =>
      http.request(
        { ...options, hostname: '127.0.0.1', port: collector.address().port },
        onResponse
      )
    );
});
afterAll(async () => {
  requestSpy.mockRestore();
  await Promise.all([close(model), close(collector), close(control)]);
});
beforeEach(() => {
  requests.length = 0;
  events.length = 0;
  syncs.length = 0;
  desired.clear();
  gate = null;
});

const openai = (options = {}) =>
  new OpenAI({
    apiKey: 'test',
    baseURL: `http://127.0.0.1:${model.address().port}/v1`,
    maxRetries: 0,
    ...options
  });
const connect = (client, extra = {}) =>
  connectOpenAI(client, {
    agentId: 'support',
    telemetryKey: 'ingest-key',
    telemetryEndpoint: 'https://telemetry.test',
    ...extra
  });
let runtimeKey;
const runtimeEndpoint = () => `http://127.0.0.1:${control.address().port}`;
const controlled = client => {
  runtimeKey = `np_runtime_${crypto.randomBytes(32).toString('base64url')}`;
  return connect(client, { runtimeKey, runtimeEndpoint: runtimeEndpoint() });
};
// Runs a fresh sync on the process's control connection for the current key.
const syncNow = async () => {
  const link = controlLink(runtimeKey, runtimeEndpoint());
  await link.syncing;
  return link.sync();
};
const calls = () =>
  events
    .filter(event => event.event === 'model.call')
    .map(event => ({ runId: event.runId, ...event.data }));
const stop = async () => {
  desired.set('support', { paused: true, revision: 1, stop_epoch: 1 });
  await syncNow();
};
const params = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Where is order 42?' }],
  temperature: 0.2
};
const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4.1-mini-2025-04-14',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Shipped' }, finish_reason: 'length' }
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
};

test('the SDK completion and the SDK error come back unchanged, with one model.call each', async () => {
  const client = openai();
  const connection = connect(client);
  handle = async res => json(res, 200, completion);
  expect(await connection.create(params)).toEqual(completion);
  expect(requests[0].body).toEqual(params);
  handle = async res => json(res, 429, { error: { message: 'Slow down' } });
  const error = await connection.create(params).catch(e => e);
  expect(error).toBeInstanceOf(OpenAI.RateLimitError);
  expect(error.status).toBe(429);
  await connection.close();
  const [completed, limited] = calls();
  // A length finish is still a completed request.
  expect(completed).toMatchObject({
    model: 'gpt-4.1-mini',
    success: true,
    inputTokens: 12,
    outputTokens: 3
  });
  expect(limited).toMatchObject({
    model: 'gpt-4.1-mini',
    success: false,
    errorCode: 'rate_limited'
  });
  expect(completed.runId).not.toBe(limited.runId);
});

test('a client timeout is the SDK timeout error and is reported as timeout', async () => {
  const connection = connect(openai({ timeout: 50 }));
  handle = async res => {
    await new Promise(r => setTimeout(r, 300));
    if (!res.destroyed) json(res, 200, completion);
  };
  await expect(connection.create(params)).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
  await connection.close();
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'timeout' })]);
});

test('a paused agent sends no request and records the refusal with the requested model', async () => {
  desired.set('support', { paused: true, revision: 1 });
  const connection = controlled(openai());
  await expect(connection.create(params)).rejects.toMatchObject({
    name: 'ControlError',
    code: 'agent_paused'
  });
  await connection.close();
  expect(requests).toHaveLength(0);
  expect(calls()).toEqual([
    expect.objectContaining({ model: 'gpt-4.1-mini', success: false, errorCode: 'agent_paused' })
  ]);
});

test('a caller abort while waiting for the first state sends nothing and leaves no active run', async () => {
  let release;
  gate = new Promise(resolve => (release = resolve));
  const connection = controlled(openai());
  const caller = new AbortController();
  const pending = connection.create(params, { signal: caller.signal });
  await until(() => syncs.length > 0);
  caller.abort(new Error('caller gave up'));
  await expect(pending).rejects.toThrow('caller gave up');
  gate = null;
  release();
  await until(() => syncs.some(sync => sync.agents[0].activeRuns === 0) && syncs.length > 1);
  await connection.close();
  expect(requests).toHaveLength(0);
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'aborted' })]);
});

test('close while waiting for the first state sends nothing and records the call as closed', async () => {
  let release;
  gate = new Promise(resolve => (release = resolve));
  const connection = controlled(openai());
  const pending = connection.create(params);
  await until(() => syncs.length > 0);
  const closing = connection.close();
  await expect(pending).rejects.toMatchObject({ code: 'control_closed' });
  release();
  await closing;
  expect(requests).toHaveLength(0);
  expect(calls()).toEqual([
    expect.objectContaining({ success: false, errorCode: 'control_closed' })
  ]);
});

test('close cancels a request in flight and records it before the events are sent', async () => {
  const connection = connect(openai());
  handle = async () => {};
  const pending = connection.create(params);
  await until(() => requests.length === 1);
  await connection.close();
  await expect(pending).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
  await until(() => requests[0].closedEarly);
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'aborted' })]);
});

test('stop cancels a request in flight with the SDK abort error', async () => {
  const connection = controlled(openai());
  handle = async () => {
    await stop();
  };
  await expect(connection.create(params)).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
  await until(() => requests[0]?.closedEarly);
  await connection.close();
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'aborted' })]);
});

const chunk = (content, extra = {}) => ({
  id: 'chatcmpl-2',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-4.1-mini-2025-04-14',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
  ...extra
});

test('a stream yields the SDK chunks and records usage when it ends', async () => {
  const sent = [
    chunk('Ship'),
    chunk('ped'),
    { ...chunk(''), choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }
  ];
  handle = async res => sse(res, sent);
  const connection = connect(openai());
  const stream = await connection.create({ ...params, stream: true });
  const received = [];
  for await (const item of stream) received.push(item);
  await connection.close();
  expect(received).toEqual(sent);
  expect(calls()).toEqual([
    expect.objectContaining({ success: true, inputTokens: 9, outputTokens: 2 })
  ]);
});

test('stop mid-stream closes the connection and raises the stop', async () => {
  const connection = controlled(openai());
  handle = async res => {
    sse(res, [chunk('Ship')], { end: false });
    await stop();
  };
  const stream = await connection.create({ ...params, stream: true });
  const received = [];
  await expect(
    (async () => {
      for await (const item of stream) received.push(item);
    })()
  ).rejects.toMatchObject({ name: 'AbortError', code: 'run_cancelled' });
  expect(received).toHaveLength(1);
  await until(() => requests[0].closedEarly);
  await connection.close();
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'aborted' })]);
});

test('leaving a stream early, even before its first chunk, closes the connection and ends the run', async () => {
  handle = async res => sse(res, [chunk('Ship'), chunk('ped')], { end: false });
  const connection = controlled(openai());
  const first = await connection.create({ ...params, stream: true });
  for await (const item of first) {
    expect(item).toEqual(chunk('Ship'));
    break;
  }
  const second = await connection.create({ ...params, stream: true });
  await second[Symbol.asyncIterator]().return();
  await until(() => requests.length === 2 && requests.every(request => request.closedEarly));
  await syncNow();
  expect(syncs.at(-1).agents[0].activeRuns).toBe(0);
  await connection.close();
  expect(calls()).toEqual([
    expect.objectContaining({ success: false, errorCode: 'aborted' }),
    expect.objectContaining({ success: false, errorCode: 'aborted' })
  ]);
});

test('close cancels an unread stream, records it, and records nothing after', async () => {
  handle = async res => sse(res, [chunk('Ship')], { end: false });
  const connection = connect(openai());
  await connection.create({ ...params, stream: true });
  await connection.close();
  await until(() => requests[0].closedEarly);
  expect(calls()).toEqual([expect.objectContaining({ success: false, errorCode: 'aborted' })]);
  await expect(connection.create(params)).rejects.toMatchObject({ code: 'control_closed' });
});

test('token counts are sent only when the provider reported valid ones, also for a failed stream', async () => {
  handle = async res =>
    json(res, 200, { ...completion, usage: { prompt_tokens: -1, completion_tokens: 2e9 } });
  const connection = connect(openai());
  await connection.create(params);
  handle = async res => {
    sse(res, [{ ...chunk(''), choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } }], {
      end: false
    });
    // Break the connection after the usage chunk has reached the client.
    await new Promise(r => setTimeout(r, 50));
    res.destroy();
  };
  const stream = await connection.create({ ...params, stream: true });
  await expect(
    (async () => {
      for await (const item of stream) expect(item).toBeDefined();
    })()
  ).rejects.toThrow();
  await connection.close();
  const [invalid, failed] = calls();
  expect(invalid).toEqual(expect.not.objectContaining({ inputTokens: expect.anything() }));
  expect(invalid).toEqual(expect.not.objectContaining({ outputTokens: expect.anything() }));
  expect(failed).toMatchObject({
    success: false,
    errorCode: 'provider_error',
    inputTokens: 7,
    outputTokens: 1
  });
});

test('an existing tool loop keeps its own messages, and each create is its own run', async () => {
  const toolCall = {
    ...completion,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"id":"42"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  };
  const answers = [toolCall, completion];
  handle = async res => json(res, 200, answers.shift());
  const connection = connect(openai());
  const tools = [
    { type: 'function', function: { name: 'get_order', parameters: { type: 'object' } } }
  ];
  const messages = [...params.messages];
  const first = await connection.create({ model: 'gpt-4.1-mini', messages, tools });
  messages.push(first.choices[0].message, {
    role: 'tool',
    tool_call_id: 'c1',
    content: '{"status":"shipped"}'
  });
  await connection.create({ model: 'gpt-4.1-mini', messages, tools });
  await connection.close();
  expect(requests[1].body.messages.at(-1)).toEqual({
    role: 'tool',
    tool_call_id: 'c1',
    content: '{"status":"shipped"}'
  });
  const [one, two] = calls();
  expect(one.runId).not.toBe(two.runId);
});
