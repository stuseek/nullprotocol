#!/usr/bin/env node
/* eslint-disable no-console -- This CLI prints progress and a summary table. */
// Runs the frozen 48 tasks against Claude with the same prompts as the local
// Qwen run: a direct Messages API call parsed with JSON.parse, and the SDK.
// There is no schema-less JSON mode on the Messages API, so the direct-json
// arm is omitted. Current Claude models reject temperature and think before
// answering, so this run sends no temperature and allows 4096 output tokens.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Anthropic = require('@anthropic-ai/sdk').default;
const { NullProtocol } = require('../src');
const tasks = require('./frozen-tasks');
const { score } = require('./score');
const { prompt } = require('./run');

const models = (process.env.NULLPROTOCOL_BENCH_MODELS || 'claude-opus-5').split(',');
const maxTokens = 4096;
const output =
  process.argv[2] ||
  path.join(
    __dirname,
    'results',
    `frozen-anthropic-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  );

function meter(client) {
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, rawResponses: [] };
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (params, options) => {
    stats.calls++;
    const response = await create(params, options);
    stats.inputTokens += response.usage.input_tokens;
    stats.outputTokens += response.usage.output_tokens;
    stats.rawResponses.push({ content: response.content, stopReason: response.stop_reason });
    return response;
  };
  return stats;
}

const text = content =>
  content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

const toolCalls = rawResponses =>
  rawResponses.flatMap(({ content }) =>
    content
      .filter(block => block.type === 'tool_use')
      .map(block => ({ name: block.name, arguments: block.input }))
  );

async function direct(task, model) {
  const client = new Anthropic({ maxRetries: 2 });
  const stats = meter(client);
  const [system, user] = prompt(task);
  const params = {
    model,
    system: system.content,
    messages: [user],
    max_tokens: maxTokens
  };
  if (task.category === 'tool') {
    params.tools = [
      {
        name: task.tool.name,
        description: task.tool.description,
        input_schema: task.tool.parameters
      }
    ];
  }
  let payload = null;
  let answer = '';
  for (let round = 0; round < 3; round++) {
    const response = await client.messages.create(params);
    if (response.stop_reason !== 'tool_use') {
      answer = text(response.content);
      if (task.category !== 'tool') {
        try {
          payload = JSON.parse(answer);
        } catch {
          payload = null;
        }
      }
      break;
    }
    params.messages.push({ role: 'assistant', content: response.content });
    params.messages.push({
      role: 'user',
      content: response.content
        .filter(block => block.type === 'tool_use')
        .map(block => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(
            block.name === task.tool.name ? task.toolResult : { error: 'not_allowed' }
          )
        }))
    });
  }
  return { payload, answer, toolCalls: toolCalls(stats.rawResponses), ...stats };
}

async function sdk(task, model) {
  const ai = new NullProtocol({
    engines: { anthropic: process.env.ANTHROPIC_API_KEY },
    defaultEngine: 'anthropic',
    models: { anthropic: model },
    maxTokens,
    telemetry: false,
    configFile: path.join(__dirname, 'no-config-file.json')
  });
  const stats = meter(ai.clients.anthropic);
  let payload = null;
  let answer = '';
  if (task.category === 'decide') {
    const result = await ai.decide(task.context, task.actions);
    payload = result.success ? { action: result.action } : null;
  } else if (task.category === 'tool') {
    const result = await ai.chat(task.prompt, {
      tools: [task.tool],
      onToolCall: name => (name === task.tool.name ? task.toolResult : { error: 'not_allowed' })
    });
    answer = result.message || '';
  } else {
    const result = await ai.extract(task.data, task.schema);
    payload = result.data;
  }
  return { payload, answer, toolCalls: toolCalls(stats.rawResponses), ...stats };
}

function sourceCommit() {
  const root = path.join(__dirname, '..');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain', '--', 'src', 'bench', 'package.json'])) {
    throw new Error('Commit the benchmark source before running it');
  }
  return git(['rev-parse', 'HEAD']);
}

async function main() {
  const manifest = {
    kind: 'anthropic-frozen-v1',
    date: new Date().toISOString(),
    sdkCommit: sourceCommit(),
    anthropicSdk: JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(require.resolve('@anthropic-ai/sdk')), 'package.json'),
        'utf8'
      )
    ).version,
    models,
    arms: ['direct', 'sdk'],
    maxTokens,
    temperature: null,
    taskSha256: createHash('sha256').update(JSON.stringify(tasks)).digest('hex'),
    tasks: tasks.length
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const rows = [];
  fs.writeFileSync(output, `${JSON.stringify({ manifest })}\n`, { flag: 'wx' });
  for (const model of models) {
    for (const [index, task] of tasks.entries()) {
      const arms = index % 2 ? ['sdk', 'direct'] : ['direct', 'sdk'];
      for (const arm of arms) {
        const started = Date.now();
        let result;
        try {
          result = await (arm === 'sdk' ? sdk(task, model) : direct(task, model));
        } catch (error) {
          result = { payload: null, answer: '', toolCalls: [], error: error.message };
        }
        const row = {
          model,
          taskId: task.id,
          category: task.category,
          arm,
          correct: score(task, result.payload, result.toolCalls, result.answer),
          wallMs: Date.now() - started,
          ...result
        };
        rows.push(row);
        fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        console.log(
          `${model} ${task.id} ${arm}: ${row.correct ? 'correct' : row.error || 'wrong'}`
        );
      }
    }
  }
  const categories = [...new Set(tasks.map(task => task.category))];
  for (const model of models) {
    for (const arm of ['direct', 'sdk']) {
      const cells = categories.map(category => {
        const matching = rows.filter(
          row => row.model === model && row.arm === arm && row.category === category
        );
        return `${category} ${matching.filter(row => row.correct).length}/${matching.length}`;
      });
      console.log(`${model} ${arm}: ${cells.join(', ')}`);
    }
  }
  console.log(`Raw results: ${output}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
