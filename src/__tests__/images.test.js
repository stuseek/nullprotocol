const { createRuntime } = require('../runtime');
const { createModel } = require('../model');

const image = 'https://images.example.test/mug.jpg';
function fixture(provider = 'openai-compatible', replies = []) {
  const requests = [];
  const records = [];
  const store = {
    settings: async () => ({ provider, model: 'vision-test' }),
    turn: async () => ({
      settings: { provider, model: 'vision-test' },
      entries: [],
      notes: [],
      missing: []
    }),
    record: async record => records.push(record)
  };
  const agent = createRuntime({
    agentId: 'vision',
    store,
    credentials: {
      [provider]: {
        apiKey: 'fixture',
        ...(provider === 'openai-compatible' || provider === 'ollama'
          ? { baseURL: 'http://model.test' }
          : {})
      }
    },
    modelFactory: (settings, options) =>
      createModel(settings, options, async (_url, request) => {
        requests.push(JSON.parse(request.body));
        const reply = replies.shift();
        return new global.Response(
          JSON.stringify(
            provider === 'anthropic'
              ? {
                  content: [{ type: 'text', text: JSON.stringify(reply) }],
                  usage: { input_tokens: 100, output_tokens: 10 }
                }
              : {
                  choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 100, completion_tokens: 10 }
                }
          )
        );
      })
  });
  return { agent, records, requests };
}

test('all four operations send photos as real input parts and preserve text/usage/history', async () => {
  const { agent, records, requests } = fixture('openai-compatible', [
    { damaged: true },
    { summary: 'A damaged mug.', keyPoints: ['Cracked handle.'] },
    { score: 1, recommendation: 'pass', reasoning: 'A crack is visible.' },
    { action: 'review', parameters: {}, reasoning: 'Review the damage.' }
  ]);
  const images = [image];
  const outputs = [
    await agent.extract('', { damaged: 'boolean' }, { images }),
    await agent.summarize('Describe the damage.', { images }),
    await agent.validate('A crack is visible.', '', { images }),
    await agent.decide('What is next?', ['review'], { images })
  ];
  expect(outputs.every(result => result.success)).toBe(true);
  for (const request of requests) {
    expect(request.messages[1].content[0].type).toBe('text');
    expect(request.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: image }
    });
  }
  images[0] = 'https://changed.example.test/other.jpg';
  expect(records.every(record => record.input.images[0] === image)).toBe(true);
  expect(outputs[0].usage).toEqual({ inputTokens: 100, outputTokens: 10 });
});

test('repairs retain image parts and Anthropic receives native image blocks', async () => {
  const { agent, requests } = fixture('anthropic', [{ damaged: 'wrong' }, { damaged: true }]);
  const result = await agent.extract('', { damaged: 'boolean' }, { images: [image] });
  expect(result.success).toBe(true);
  expect(result.repaired).toBe(true);
  expect(requests[1].messages[0].content[1]).toEqual({
    type: 'image',
    source: { type: 'url', url: image }
  });
  expect(requests[1].messages[2].content).toContain('JSON');
  expect(result.usage.inputTokens).toBe(200);
});

test('invalid photo options and native Ollama URL input never reach the provider', async () => {
  for (const images of [
    'photo.jpg',
    ['http://example.test/photo.jpg'],
    ['data:image/png;base64,AAAA'],
    ['https://user:pass@example.test/photo.jpg'],
    Array(5).fill(image)
  ]) {
    const { agent, requests } = fixture();
    const result = await agent.extract('', { text: 'string' }, { images });
    expect(result.errorCode).toBe('invalid_images');
    expect(requests).toHaveLength(0);
  }
  const { agent, requests, records } = fixture('ollama');
  const result = await agent.extract('', { text: 'string' }, { images: [image] });
  expect(result.errorCode).toBe('provider_images_not_supported');
  expect(requests).toHaveLength(0);
  expect(records[0].modelCalls).toBe(0);
});

test('Knowledge searches the task text, never photo URLs', async () => {
  const { agent, requests } = fixture();
  const result = await agent.extract(
    '',
    { damaged: 'boolean' },
    { images: [image], knowledge: true }
  );
  expect(result.errorCode).toBe('knowledge_query_required');
  expect(requests).toHaveLength(0);
});
