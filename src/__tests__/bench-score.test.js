const { score } = require('../../bench/score');
const { prompt } = require('../../bench/run');
const tasks = require('../../bench/tasks');
const { NullProtocol } = require('..');

test('a valid shape with the wrong fact is still incorrect', () => {
  const task = {
    category: 'extract',
    expected: { sku: 'MUG-9', currentCount: 25 }
  };
  expect(score(task, { sku: 'MUG-9', currentCount: 28 })).toBe(false);
  expect(score(task, { sku: 'MUG-9', currentCount: 25, guess: true })).toBe(false);
  expect(score(task, { sku: 'MUG-9', currentCount: 25 })).toBe(true);
});

test('a tool answer requires the right call as well as the right text', () => {
  const task = {
    category: 'tool',
    expectedCall: { name: 'lookup_order', arguments: { id: 42 } },
    expectedText: 'shipped',
    forbiddenAnswers: ['not shipped', 'not yet shipped']
  };
  expect(score(task, null, [], 'Order 42 was shipped')).toBe(false);
  expect(score(task, null, [{ name: 'lookup_order', arguments: { id: 41 } }], 'Shipped')).toBe(
    false
  );
  expect(
    score(task, null, [{ name: 'lookup_order', arguments: { id: 42 } }], 'Order was shipped')
  ).toBe(true);
  expect(
    score(task, null, [{ name: 'lookup_order', arguments: { id: 42 } }], 'Order was not shipped')
  ).toBe(false);
  expect(
    score(task, null, [{ name: 'lookup_order', arguments: { id: 42 } }], 'Order was unshipped')
  ).toBe(false);
});

test('frozen tool tasks require an exact grounded answer', () => {
  const task = {
    category: 'tool',
    expectedCall: { name: 'lookup_booking', arguments: { id: 18 } },
    expectedAnswer: 'gate=B12'
  };
  const call = [task.expectedCall];
  expect(score(task, null, call, 'gate=B12')).toBe(true);
  expect(score(task, null, call, 'gate=not B12')).toBe(false);
  expect(score(task, null, call, 'gate=B12 or C7')).toBe(false);
});

test('a decision is scored on its chosen action, not the SDK success flag', () => {
  expect(score({ category: 'decide', expected: 'rollback' }, { action: 'monitor' })).toBe(false);
  expect(score({ category: 'decide', expected: 'rollback' }, { action: 'rollback' })).toBe(true);
});

test.each(['extract', 'decide', 'tool'])(
  'the direct %s request matches the SDK provider request',
  async category => {
    const task = tasks.find(item => item.category === category);
    const ai = new NullProtocol({
      engines: { openai: 'local' },
      defaultEngine: 'openai',
      openaiBaseURL: 'http://127.0.0.1:11434/v1',
      models: { openai: 'bench-model' },
      temperature: 0,
      maxTokens: 280,
      telemetry: false,
      retry: { maxRetries: 0 },
      configFile: '/nonexistent/nullprotocol-bench-config.json'
    });
    let sent;
    ai.clients.openai.chat.completions.create = async params => {
      sent = JSON.parse(JSON.stringify(params));
      const content =
        category === 'tool'
          ? 'Done'
          : category === 'decide'
            ? JSON.stringify({
                action: task.expected,
                reasoning: 'rule',
                confidence: 1,
                parameters: {}
              })
            : JSON.stringify(task.expected);
      return { choices: [{ message: { content } }] };
    };
    if (category === 'extract') {
      await ai.extract(task.data, task.schema);
    }
    if (category === 'decide') {
      await ai.decide(task.context, task.actions);
    }
    if (category === 'tool') {
      await ai.chat(task.prompt, { tools: [task.tool], onToolCall: () => task.toolResult });
    }
    expect(sent).toEqual({
      model: 'bench-model',
      messages: prompt(task),
      temperature: 0,
      max_tokens: 280,
      ...(category === 'tool' ? { tools: [{ type: 'function', function: task.tool }] } : {})
    });
  }
);
