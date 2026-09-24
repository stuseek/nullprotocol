const AIToolkit = require('../index');
const { ActionExecutor, ConfirmationRequiredError } = require('../executor');
const { Resilience } = require('../resilience');
const { validateExtraction } = require('../schema');

describe('safety regressions', () => {
  test('action marked for confirmation cannot run on model output alone', async () => {
    const executor = new ActionExecutor();
    const handler = jest.fn().mockResolvedValue('sent');
    executor.register('send', handler, { requiresConfirmation: true });
    const decision = { action: 'send', parameters: { to: 'someone' }, confirmed: true };

    await expect(executor.execute(decision)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(handler).not.toHaveBeenCalled();
    await executor.execute(decision, { confirm: async () => true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('model retry after a tool call does not repeat the tool side effect', async () => {
    const ai = new AIToolkit({ engines: { openai: 'test' }, retry: { maxRetries: 1 }, timeout: 0 });
    ai.resilience._sleep = async () => {};
    const tool = jest.fn().mockResolvedValue({ ok: true });
    let calls = 0;
    ai.clients.openai = {
      chat: {
        completions: {
          create: jest.fn(async () => {
            calls++;
            if (calls === 1) {
              return {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      tool_calls: [{ id: '1', function: { name: 'write', arguments: '{}' } }]
                    }
                  }
                ]
              };
            }
            if (calls === 2) {
              const error = new Error('rate limit');
              error.status = 429;
              throw error;
            }
            return { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] };
          })
        }
      }
    };

    const result = await ai.chat('go', { tools: [{ name: 'write' }], onToolCall: tool });
    expect(result.success).toBe(true);
    expect(result.message).toBe('done');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
  });

  test('managed inference never retries an ambiguous request automatically', async () => {
    const ai = new AIToolkit({
      engines: { openai: `np_inf_${'x'.repeat(43)}` },
      openaiBaseURL: 'http://127.0.0.1:3001/v1',
      retry: { maxRetries: 1 },
      timeout: 0
    });
    ai.resilience._sleep = async () => {};
    const options = [];
    ai.clients.openai = {
      chat: {
        completions: {
          create: jest.fn(async (_, requestOptions) => {
            options.push(requestOptions);
            if (options.length === 1) {
              throw Object.assign(new Error('temporary'), { status: 503 });
            }
            return { choices: [{ message: { content: 'done' } }] };
          })
        }
      }
    };

    expect((await ai.chat('hello')).success).toBe(false);
    expect(options).toHaveLength(1);
    expect(options[0].headers['X-NullProtocol-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('managed inference key requires explicit gateway and rejects streaming', async () => {
    const key = `np_inf_${'x'.repeat(43)}`;
    expect(() => new AIToolkit({ engines: { openai: key } })).toThrow('openaiBaseURL');
    expect(
      () =>
        new AIToolkit({
          engines: { openai: key },
          openaiBaseURL: 'https://api.openai.com/v1'
        })
    ).toThrow('non-OpenAI');
    const ai = new AIToolkit({
      engines: { openai: key },
      openaiBaseURL: 'http://127.0.0.1:3001/v1'
    });
    const stream = ai.makeStreamRequest({ system: 'hi', user: 'hello' });
    await expect(stream.next()).rejects.toThrow('does not support streaming');
  });

  test('timeout aborts the in-flight request before retry', async () => {
    const resilience = new Resilience({ timeout: 5, maxRetries: 1 });
    resilience._sleep = async () => {};
    const signals = [];
    await expect(
      resilience.execute(signal => {
        signals.push(signal);
        return new Promise(() => {});
      })
    ).rejects.toThrow('timed out');
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  test('simple schemas and JSON Schema both reject malformed extraction', () => {
    expect(validateExtraction({ age: 'twelve' }, { age: 'number' }).isValid).toBe(false);
    expect(
      validateExtraction(
        { age: 'twelve' },
        {
          type: 'object',
          properties: { age: { type: 'number' } },
          required: ['age']
        }
      ).isValid
    ).toBe(false);
  });

  test('opt-in telemetry includes usage numbers but no prompt', async () => {
    const ai = new AIToolkit({
      engines: { openai: 'test' },
      telemetry: true,
      telemetryKey: 'key',
      telemetryEndpoint: 'https://example.test',
      telemetryPath: '/custom-ingest',
      timeout: 0
    });
    expect(ai.telemetry.path).toBe('/custom-ingest');
    ai.telemetry.track = jest.fn();
    ai.clients.openai = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 }
          })
        }
      }
    };

    const result = await ai.chat('private prompt');
    expect(result.success).toBe(true);
    expect(ai.telemetry.track).toHaveBeenCalledWith('model_usage', {
      engine: 'openai',
      model: 'gpt-4',
      inputTokens: 12,
      outputTokens: 3
    });
    expect(JSON.stringify(ai.telemetry.track.mock.calls)).not.toContain('private prompt');
    ai.telemetry.enabled = false;
    await ai.telemetry.destroy();
  });

  test('streams local OpenAI-compatible output without storing history by default', async () => {
    const ai = new AIToolkit({
      engines: { openai: 'local' },
      openaiBaseURL: 'http://127.0.0.1:1234/v1',
      models: { openai: 'small' }
    });
    const create = jest.fn().mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: 'hel' } }] };
        yield { choices: [{ delta: { content: 'lo' } }] };
      })()
    );
    ai.clients.openai = { chat: { completions: { create } } };

    const result = await ai.chat('say hello', { stream: true, collect: true });
    expect(result).toMatchObject({ success: true, message: 'hello' });
    expect(create.mock.calls[0][0].model).toBe('small');
    expect(create.mock.calls[0][0].messages).toHaveLength(2);
    expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(ai.getHistory()).toEqual([]);
  });

  test('streams Anthropic text deltas', async () => {
    const ai = new AIToolkit({
      engines: { anthropic: 'test' },
      defaultEngine: 'anthropic',
      models: { anthropic: 'small' }
    });
    ai.clients.anthropic = {
      messages: {
        stream: jest.fn(() =>
          (async function* () {
            yield { type: 'content_block_delta', delta: { text: 'ready' } };
          })()
        )
      }
    };

    const result = await ai.chat('status?', { stream: true, collect: true });
    expect(result.message).toBe('ready');
    expect(ai.clients.anthropic.messages.stream).toHaveBeenCalledTimes(1);
  });

  test('sliding window removes whole old turns and keeps the current request', async () => {
    const ai = new AIToolkit({ engines: { openai: 'test' }, maxContextLength: 50 });
    ai.addMessage('user', 'a'.repeat(20));
    ai.addMessage('assistant', 'b'.repeat(20));
    ai.addMessage('user', 'c'.repeat(20));
    ai.addMessage('assistant', 'd'.repeat(20));
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    ai.clients.openai = { chat: { completions: { create } } };

    const response = await ai.makeAIRequest(
      { system: 'rules', user: 'now' },
      { includeHistory: true }
    );
    expect(response).toBe('ok');
    expect(create.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'c'.repeat(20) },
      { role: 'assistant', content: 'd'.repeat(20) },
      { role: 'user', content: 'now' }
    ]);
    expect(ai.getHistory()).toHaveLength(2);
  });

  test('context budget rejects an oversized current request without calling the model', async () => {
    const ai = new AIToolkit({ engines: { openai: 'test' } });
    ai.setMaxContextLength(10);
    const create = jest.fn();
    ai.clients.openai = { chat: { completions: { create } } };

    const result = await ai.chat('A long current request');
    expect(result.success).toBe(false);
    expect(result.error).toContain('maxContextLength');
    expect(create).not.toHaveBeenCalled();
  });

  test('tool results trim old chat turns before the next OpenAI request', async () => {
    const ai = new AIToolkit({ engines: { openai: 'test' }, maxContextLength: 190 });
    ai.addMessage('user', 'a'.repeat(70));
    ai.addMessage('assistant', 'b'.repeat(70));
    const requests = [];
    ai.clients.openai = {
      chat: {
        completions: {
          create: jest.fn(async params => {
            requests.push(JSON.parse(JSON.stringify(params.messages)));
            return requests.length === 1
              ? {
                  choices: [
                    {
                      finish_reason: 'tool_calls',
                      message: {
                        role: 'assistant',
                        tool_calls: [{ id: '1', function: { name: 'read', arguments: '{}' } }]
                      }
                    }
                  ]
                }
              : { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] };
          })
        }
      }
    };

    const response = await ai.makeAIRequest(
      { system: 'rules', user: 'now' },
      { includeHistory: true, tools: [{ name: 'read' }], onToolCall: async () => 'x'.repeat(60) }
    );
    expect(response.text).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveLength(4);
    expect(requests[1].map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool'
    ]);
    expect(ai.getHistory()).toEqual([]);
  });

  test.each(['openai', 'anthropic'])(
    '%s tool results cannot exceed the current context budget',
    async engine => {
      const ai = new AIToolkit({
        engines: { [engine]: 'test' },
        defaultEngine: engine,
        maxContextLength: 120
      });
      ai.addMessage('user', 'old question');
      ai.addMessage('assistant', 'old answer');
      const savedHistory = ai.getHistory();
      const create = jest.fn().mockResolvedValue(
        engine === 'openai'
          ? {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    tool_calls: [{ id: '1', function: { name: 'read', arguments: '{}' } }]
                  }
                }
              ]
            }
          : {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: '1', name: 'read', input: {} }]
            }
      );
      ai.clients[engine] =
        engine === 'openai' ? { chat: { completions: { create } } } : { messages: { create } };

      await expect(
        ai.makeAIRequest(
          { system: 'rules', user: 'now' },
          {
            includeHistory: true,
            tools: [{ name: 'read' }],
            onToolCall: async () => 'x'.repeat(150)
          }
        )
      ).rejects.toThrow('maxContextLength');
      expect(create).toHaveBeenCalledTimes(1);
      expect(ai.getHistory()).toEqual(savedHistory);
    }
  );
});
