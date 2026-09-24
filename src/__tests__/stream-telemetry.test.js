const AIToolkit = require('../index');

const agents = [];

function agent() {
  const ai = new AIToolkit({
    engines: { openai: 'local' },
    openaiBaseURL: 'http://127.0.0.1:1234/v1',
    models: { openai: 'small' },
    telemetry: true,
    telemetryTimeline: true,
    telemetryKey: 'test',
    telemetryEndpoint: 'https://telemetry.example.test'
  });
  agents.push(ai);
  return ai;
}

afterEach(async () => {
  for (const ai of agents.splice(0)) {
    ai.telemetry.enabled = false;
    await ai.telemetry.destroy();
  }
});

test('collected OpenAI stream reports one run with provider usage and no content', async () => {
  const ai = agent();
  const create = jest.fn().mockResolvedValue(
    (async function* () {
      yield { choices: [{ delta: { content: 'private reply' } }] };
      yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } };
    })()
  );
  ai.clients.openai = { chat: { completions: { create } } };

  const result = await ai.chat('private prompt', { stream: true, collect: true });
  expect(result).toMatchObject({ success: true, message: 'private reply' });
  expect(create.mock.calls[0][0].stream_options).toBeUndefined();
  const events = ai.telemetry.queue;
  expect(events.map(event => event.event)).toEqual([
    'model_usage',
    'ai_request',
    'chat',
    'run.trace'
  ]);
  expect(new Set(events.map(event => event.runId)).size).toBe(1);
  expect(events[0].data).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  expect(events[3].data).toMatchObject({
    status: 'completed',
    stepsTotal: 1,
    steps: [{ kind: 'model', success: true, model: 'small', inputTokens: 12, outputTokens: 3 }]
  });
  expect(JSON.stringify(events)).not.toContain('private prompt');
  expect(JSON.stringify(events)).not.toContain('private reply');
});

test('interleaved generators keep their own run IDs and report once each', async () => {
  const ai = agent();
  ai.makeStreamRequest = async function* ({ user }) {
    yield user === 'secret A' ? 'reply A' : 'reply B';
    yield '!';
  };
  const a = await ai.chat('secret A', { stream: true });
  const b = await ai.chat('secret B', { stream: true });
  expect((await a.next()).value).toBe('reply A');
  expect((await b.next()).value).toBe('reply B');
  expect((await b.next()).value).toBe('!');
  expect((await a.next()).value).toBe('!');
  expect((await a.next()).done).toBe(true);
  expect((await b.next()).done).toBe(true);

  const chats = ai.telemetry.queue.filter(event => event.event === 'chat');
  const traces = ai.telemetry.queue.filter(event => event.event === 'run.trace');
  expect(chats).toHaveLength(2);
  expect(traces).toHaveLength(2);
  expect(chats[0].runId).not.toBe(chats[1].runId);
  expect(new Set(traces.map(event => event.runId))).toEqual(
    new Set(chats.map(event => event.runId))
  );
  expect(JSON.stringify(ai.telemetry.queue)).not.toMatch(/secret [AB]|reply [AB]/);
});

test('early close reports an aborted stream without saving the reply', async () => {
  const ai = agent();
  let closed = false;
  ai.makeStreamRequest = async function* () {
    try {
      yield 'secret reply';
      yield 'more';
    } finally {
      closed = true;
    }
  };
  const stream = await ai.chat('secret prompt', { stream: true });
  expect((await stream.next()).value).toBe('secret reply');
  await stream.return();
  expect(closed).toBe(true);
  expect(ai.telemetry.queue.filter(event => event.event === 'chat')).toHaveLength(1);
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data).toMatchObject({
    success: false,
    errorCode: 'aborted'
  });
  expect(ai.telemetry.queue.find(event => event.event === 'run.trace').data.status).toBe('aborted');
  expect(JSON.stringify(ai.telemetry.queue)).not.toContain('secret reply');
});

test('provider failure is reported without changing collected chat failure', async () => {
  const ai = agent();
  ai.makeStreamRequest = async function* () {
    yield 'partial private reply';
    throw Object.assign(new Error('private provider error'), { status: 429 });
  };
  const result = await ai.chat('private prompt', { stream: true, collect: true });
  expect(result).toMatchObject({ success: false, error: 'private provider error' });
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data).toMatchObject({
    success: false,
    errorCode: 'rate_limited'
  });
  expect(ai.telemetry.queue.find(event => event.event === 'run.trace').data).toMatchObject({
    status: 'failed',
    stepsTotal: 1
  });
  expect(JSON.stringify(ai.telemetry.queue)).not.toMatch(
    /private prompt|private reply|private provider error/
  );
});

test('Anthropic stream reports usage only when the provider sends it', async () => {
  const ai = agent();
  ai.defaultEngine = 'anthropic';
  ai.config.models.anthropic = 'small-claude';
  ai.clients.anthropic = {
    messages: {
      stream: jest.fn(() =>
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 8 } } };
          yield { type: 'content_block_delta', delta: { text: 'secret answer' } };
          yield { type: 'message_delta', usage: { output_tokens: 4 } };
        })()
      )
    }
  };
  const result = await ai.chat('secret question', { stream: true, collect: true });
  expect(result.message).toBe('secret answer');
  expect(ai.telemetry.queue.find(event => event.event === 'model_usage').data).toMatchObject({
    inputTokens: 8,
    outputTokens: 4
  });
  expect(JSON.stringify(ai.telemetry.queue)).not.toMatch(/secret question|secret answer/);
});

test('provider stream that ends quietly after abort is reported as a timeout', async () => {
  const ai = agent();
  ai.config.timeout = 5;
  ai.clients.openai = {
    chat: {
      completions: {
        create: jest.fn(async (_, request) =>
          (async function* () {
            yield { choices: [{ delta: { content: 'private partial reply' } }] };
            await new Promise(resolve =>
              request.signal.addEventListener('abort', resolve, { once: true })
            );
            // OpenAI can swallow its abort and end iteration normally.
          })()
        )
      }
    }
  };
  const result = await ai.chat('secret prompt', { stream: true, collect: true });
  expect(result).toMatchObject({ success: false });
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.errorCode).toBe('timeout');
  expect(ai.telemetry.queue.find(event => event.event === 'run.trace').data).toMatchObject({
    status: 'failed',
    steps: [{ errorCode: 'timeout', success: false }]
  });
  expect(JSON.stringify(ai.telemetry.queue)).not.toMatch(/private partial reply|secret prompt/);
});

test('slow OpenAI stream consumer does not use up the provider timeout', async () => {
  const ai = agent();
  ai.config.timeout = 10;
  ai.clients.openai = {
    chat: {
      completions: {
        create: jest.fn(async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'full ' } }] };
            yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] };
          })()
        )
      }
    }
  };
  const stream = await ai.chat('prompt', { stream: true });
  expect((await stream.next()).value).toBe('full ');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await stream.next()).value).toBe('answer');
  expect((await stream.next()).done).toBe(true);
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.success).toBe(true);
});

test('OpenAI postamble that hangs after the final answer is aborted without losing the reply', async () => {
  const ai = agent();
  ai.config.timeout = 5;
  ai.clients.openai = {
    chat: {
      completions: {
        create: jest.fn(async (_, request) =>
          (async function* () {
            yield { choices: [{ delta: { content: 'full answer' }, finish_reason: 'stop' }] };
            await new Promise(resolve =>
              request.signal.addEventListener('abort', resolve, { once: true })
            );
            throw new Error('postamble connection closed');
          })()
        )
      }
    }
  };
  const result = await ai.chat('prompt', { stream: true, collect: true });
  expect(result).toMatchObject({ success: true, message: 'full answer' });
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.success).toBe(true);
});

test('slow Anthropic stream consumer does not use up the provider timeout', async () => {
  const ai = agent();
  ai.config.timeout = 10;
  ai.defaultEngine = 'anthropic';
  ai.clients.anthropic = {
    messages: {
      stream: jest.fn(() =>
        (async function* () {
          yield { type: 'content_block_delta', delta: { text: 'full ' } };
          yield { type: 'content_block_delta', delta: { text: 'answer' } };
          yield { type: 'message_stop' };
        })()
      )
    }
  };
  const stream = await ai.chat('prompt', { stream: true });
  expect((await stream.next()).value).toBe('full ');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await stream.next()).value).toBe('answer');
  expect((await stream.next()).done).toBe(true);
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.success).toBe(true);
});

test('Anthropic abort while reading is classified as a timeout', async () => {
  const ai = agent();
  ai.config.timeout = 5;
  ai.defaultEngine = 'anthropic';
  ai.clients.anthropic = {
    messages: {
      stream: jest.fn((_, request) =>
        (async function* () {
          yield { type: 'content_block_delta', delta: { text: 'partial' } };
          await new Promise(resolve =>
            request.signal.addEventListener('abort', resolve, { once: true })
          );
          throw Object.assign(new Error('abort'), { name: 'APIUserAbortError' });
        })()
      )
    }
  };
  const result = await ai.chat('prompt', { stream: true, collect: true });
  expect(result.success).toBe(false);
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.errorCode).toBe('timeout');
});

test('configuration failure before a model call has no model step', async () => {
  const ai = agent();
  delete ai.clients.openai;
  const result = await ai.chat('prompt', { stream: true, collect: true });
  expect(result.success).toBe(false);
  expect(ai.telemetry.queue.find(event => event.event === 'chat').data.errorCode).toBe(
    'config_error'
  );
  expect(ai.telemetry.queue.find(event => event.event === 'run.trace').data.stepsTotal).toBe(0);
});

test('nested collected stream adds a model step to its open parent trace', async () => {
  const ai = agent();
  ai.clients.openai = {
    chat: {
      completions: {
        create: jest.fn(async () =>
          (async function* () {
            yield { choices: [{ delta: { content: 'reply' } }] };
          })()
        )
      }
    }
  };
  const runId = '33333333-3333-4333-a333-333333333333';
  await ai._runWithTrace('validate', runId, async () => {
    const result = await ai.chat('prompt', { stream: true, collect: true });
    expect(result.success).toBe(true);
  });
  const trace = ai.telemetry.queue.find(event => event.event === 'run.trace');
  expect(trace.runId).toBe(runId);
  expect(trace.data.stepsTotal).toBe(1);
  expect(trace.data.steps[0]).toMatchObject({ kind: 'model', success: true });
});

test('telemetry failure cannot replace a successful streamed reply', async () => {
  const ai = agent();
  ai.makeStreamRequest = async function* () {
    yield 'hello';
  };
  ai.telemetry.track = () => {
    throw new Error('telemetry offline');
  };
  const result = await ai.chat('prompt', { stream: true, collect: true });
  expect(result).toMatchObject({ success: true, message: 'hello' });
});

test('unconsumed generator does not report a model call', async () => {
  const ai = agent();
  await ai.chat('prompt', { stream: true });
  expect(ai.telemetry.queue).toEqual([]);
});

test('standalone streaming returns the original generator without telemetry', async () => {
  const ai = new AIToolkit({
    engines: { openai: 'local' },
    openaiBaseURL: 'http://127.0.0.1:1234/v1',
    models: { openai: 'small' }
  });
  const generator = (async function* () {
    yield 'reply';
  })();
  ai.makeStreamRequest = jest.fn(() => generator);
  const stream = await ai.chat('prompt', { stream: true });
  expect(stream).toBe(generator);
  expect((await stream.next()).value).toBe('reply');
});

test('a later consumer does not add a stream step to another run', async () => {
  const ai = agent();
  ai.makeStreamRequest = async function* () {
    yield 'reply';
  };
  const outer = '11111111-1111-4111-a111-111111111111';
  const other = '22222222-2222-4222-a222-222222222222';
  const stream = await ai._runWithTrace('validate', outer, () =>
    ai.chat('prompt', { stream: true })
  );
  await ai._runWithTrace('summarize', other, async () => {
    for await (const _ of stream) {
      // Consume under a different AsyncLocalStorage context.
    }
  });
  const chat = ai.telemetry.queue.find(event => event.event === 'chat');
  expect(chat.runId).toBe(outer);
  const traces = ai.telemetry.queue.filter(event => event.event === 'run.trace');
  expect(traces).toHaveLength(2);
  expect(traces.find(event => event.runId === other).data.stepsTotal).toBe(0);
});
