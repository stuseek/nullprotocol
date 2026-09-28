const { runTextTurn } = require('../managed-model');

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
