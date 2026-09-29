const { runTextTurn, requestBody } = require('../managed-model');

const messages = [
  { role: 'system', content: 'Answer briefly.' },
  { role: 'user', content: 'Hello' }
];

test('sends one bounded model turn to a loopback OpenAI-compatible endpoint', async () => {
  const fetchImpl = jest.fn(
    async () =>
      new globalThis.Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello back' } }],
          usage: { prompt_tokens: 13, completion_tokens: 4 }
        }),
        { status: 200 }
      )
  );
  const result = await runTextTurn({
    model: 'local-model',
    messages,
    credential: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'local-secret' },
    fetchImpl
  });
  expect(result).toEqual({ text: 'Hello back', usage: { inputTokens: 13, outputTokens: 4 } });
  expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  expect(fetchImpl.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer local-secret');
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages).toEqual(messages);
});

test('rejects unapproved plaintext provider endpoints and never sends the key', async () => {
  const fetchImpl = jest.fn();
  await expect(
    runTextTurn({
      model: 'remote',
      messages,
      credential: { baseURL: 'http://remote.example/v1', apiKey: 'secret' },
      fetchImpl
    })
  ).rejects.toMatchObject({ code: 'model_unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('does not leak provider errors or silently retry a failed call', async () => {
  const fetchImpl = jest.fn(
    async () =>
      new globalThis.Response(JSON.stringify({ error: 'secret provider detail' }), { status: 500 })
  );
  await expect(
    runTextTurn({
      model: 'remote',
      messages,
      credential: { baseURL: 'https://model.example/v1', apiKey: 'secret' },
      fetchImpl
    })
  ).rejects.toMatchObject({ code: 'model_error' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('an abort signal stops the provider request', async () => {
  const controller = new AbortController();
  const fetchImpl = jest.fn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        });
      })
  );
  const request = runTextTurn({
    model: 'local',
    messages,
    credential: { baseURL: 'http://localhost:11434/v1' },
    signal: controller.signal,
    fetchImpl
  });
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: 'run_cancelled' });
});

test('parses a bounded function call without trusting its id as a platform call id', async () => {
  const tools = [
    {
      type: 'function',
      function: { name: 'getOrder', description: 'Read an order', parameters: { type: 'object' } }
    }
  ];
  const fetchImpl = jest.fn(
    async () =>
      new globalThis.Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'provider-call-1',
                    type: 'function',
                    function: { name: 'getOrder', arguments: '{"id":"123"}' }
                  }
                ]
              }
            }
          ]
        })
      )
  );
  const result = await runTextTurn({
    model: 'local',
    messages,
    tools,
    credential: { baseURL: 'http://localhost:11434/v1' },
    fetchImpl
  });
  expect(result.toolCalls).toEqual([
    { providerCallId: 'provider-call-1', name: 'getOrder', args: { id: '123' } }
  ]);
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tools).toEqual(tools);
});

describe('text protocol for models without tool calling', () => {
  const tool = (name, description = 'Read one order') => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object' } }
  });
  const tools = [tool('getOrder')];
  const credential = { baseURL: 'http://127.0.0.1:11434/v1', toolCalls: false };
  const reply = content =>
    jest.fn(
      async () =>
        new globalThis.Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200
        })
    );
  const sent = fetchImpl => JSON.parse(fetchImpl.mock.calls[0][1].body);

  test('turns a decide-style reply into a native-shaped tool call without sending tools', async () => {
    const fetchImpl = reply('Sure.\n```json\n{"action":"getOrder","parameters":{"id":"42"}}\n```');
    const result = await runTextTurn({ model: 'm', messages, tools, credential, fetchImpl });
    const [call] = result.toolCalls;
    expect(call).toEqual({
      providerCallId: expect.any(String),
      name: 'getOrder',
      args: { id: '42' }
    });
    expect(result.assistantMessage.tool_calls).toEqual([
      {
        id: call.providerCallId,
        type: 'function',
        function: { name: 'getOrder', arguments: '{"id":"42"}' }
      }
    ]);
    expect(sent(fetchImpl).tools).toBeUndefined();
    expect(sent(fetchImpl).messages.at(-1).content).toContain('"action":"getOrder"');
  });

  test('keeps the protocol after every action is removed and never sends role tool', async () => {
    const history = [
      ...messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'refund', arguments: '{"id":"41"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"done"}' }
    ];
    const fetchImpl = reply('{"answer":"The refund is done."}');
    const result = await runTextTurn({
      model: 'm',
      messages: history,
      tools: [],
      credential,
      fetchImpl
    });
    expect(result.text).toBe('The refund is done.');
    const wire = sent(fetchImpl).messages;
    expect(wire.map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'system'
    ]);
    expect(wire[2].content).toBe('{"action":"refund","parameters":{"id":"41"}}');
    expect(wire[3].content).toBe('Action result: {"status":"done"}');
    expect(fetchImpl.mock.calls[0][1].body).toBe(
      requestBody({ model: 'm', messages: history, tools: [], credential })
    );
  });

  test('an action named reply is callable; the answer has its own envelope', async () => {
    const withReply = [tool('reply', 'Send a reply to the customer')];
    const called = await runTextTurn({
      model: 'm',
      messages,
      tools: withReply,
      credential,
      fetchImpl: reply('{"action":"reply","parameters":{"body":"hi"}}')
    });
    expect(called.toolCalls[0]).toMatchObject({ name: 'reply', args: { body: 'hi' } });
    const answered = await runTextTurn({
      model: 'm',
      messages,
      tools: withReply,
      credential,
      fetchImpl: reply('{"answer":"Sent."}')
    });
    expect(answered.text).toBe('Sent.');
  });

  test('returns prose as text and rejects unknown actions and empty answers', async () => {
    const prose = await runTextTurn({
      model: 'm',
      messages,
      tools,
      credential,
      fetchImpl: reply('It shipped yesterday.')
    });
    expect(prose.text).toBe('It shipped yesterday.');
    for (const content of ['{"action":"refund","parameters":{}}', '{"answer":"  "}']) {
      await expect(
        runTextTurn({ model: 'm', messages, tools, credential, fetchImpl: reply(content) })
      ).rejects.toMatchObject({ code: 'invalid_model_response' });
    }
  });
});
