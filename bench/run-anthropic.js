#!/usr/bin/env node
/* eslint-disable no-console -- This CLI prints progress and a summary table. */
// Runs the frozen 48 tasks against Claude with the local run's prompts: a
// direct Messages API call parsed with JSON.parse, and the SDK. Both arms get
// the same logical call budget (1 structured, 3 tool), no transport retries
// and the same timeout. There is no schema-less JSON mode on the Messages API,
// so the direct-json arm is omitted. Current Claude models reject temperature
// and think before answering, so no temperature is sent, thinking and effort
// stay at the provider default, and each call may use 4096 output tokens
// (the local run capped calls at 280).
//
//   npm run bench:anthropic [-- OUTPUT.jsonl]
//   node bench/run-anthropic.js --report FILE.jsonl
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const tasks = require('./frozen-tasks');
const { score } = require('./score');
const { prompt } = require('./prompts');

const KIND = 'anthropic-frozen-v1';
const ARMS = ['direct', 'sdk'];
const maxTokens = 4096;
const timeout = 120_000;
const budgetFor = task => (task.category === 'tool' ? 3 : 1);
const taskSha256 = createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
const root = path.join(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function meter(client, budget) {
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, rawResponses: [] };
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (params, options) => {
    if (stats.calls >= budget) throw new Error('budget_exhausted');
    stats.calls++;
    const response = await create(params, { ...options, maxRetries: 0 });
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

function toolResult(task, name) {
  return name === task.tool.name ? task.toolResult : { error: 'not_allowed' };
}

function failure(error, stats) {
  if (error.message === 'budget_exhausted') return 'budget_exhausted';
  if (stats.rawResponses.at(-1)?.stopReason === 'max_tokens') return 'truncated';
  return 'error';
}

async function direct(task, model) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ maxRetries: 0, timeout });
  const stats = meter(client, budgetFor(task));
  const [system, user] = prompt(task);
  const params = { model, system: system.content, messages: [user], max_tokens: maxTokens };
  if (task.category === 'tool') {
    params.tools = [
      {
        name: task.tool.name,
        description: task.tool.description,
        input_schema: task.tool.parameters
      }
    ];
  }
  let status = 'ok';
  let accepted = false;
  let payload = null;
  let answer = '';
  try {
    for (;;) {
      const response = await client.messages.create(params);
      if (response.stop_reason !== 'tool_use') {
        answer = text(response.content);
        // The raw baseline may still parse an incomplete reply; keep it
        // accepted but record why it stopped.
        if (response.stop_reason === 'max_tokens') status = 'truncated';
        if (response.stop_reason === 'refusal') status = 'refused';
        if (task.category === 'tool') {
          accepted = !!answer.trim();
          if (!accepted && status === 'ok') status = 'empty_response';
        } else {
          try {
            payload = JSON.parse(answer);
            accepted = true;
          } catch {
            if (status === 'ok') status = 'parse_fail';
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
            content: JSON.stringify(toolResult(task, block.name))
          }))
      });
    }
  } catch (error) {
    status = failure(error, stats);
  }
  return { status, accepted, payload, answer, toolCalls: toolCalls(stats.rawResponses), ...stats };
}

async function sdk(task, model) {
  const { NullProtocol } = require('../src');
  const ai = new NullProtocol({
    engines: { anthropic: process.env.ANTHROPIC_API_KEY },
    defaultEngine: 'anthropic',
    models: { anthropic: model },
    maxTokens,
    timeout,
    retry: { maxRetries: 0 },
    telemetry: false,
    configFile: false
  });
  const stats = meter(ai.clients.anthropic, budgetFor(task));
  let status = 'ok';
  let accepted = false;
  let payload = null;
  let answer = '';
  try {
    let result;
    if (task.category === 'decide') {
      result = await ai.decide(task.context, task.actions);
      payload = result.success ? { action: result.action } : null;
    } else if (task.category === 'tool') {
      result = await ai.chat(task.prompt, {
        tools: [task.tool],
        onToolCall: name => toolResult(task, name)
      });
      answer = result.message || '';
    } else {
      result = await ai.extract(task.data, task.schema);
      payload = result.data;
    }
    accepted = result.success;
    if (!accepted) {
      status = result.error?.includes('budget_exhausted')
        ? 'budget_exhausted'
        : stats.rawResponses.at(-1)?.stopReason === 'max_tokens'
          ? 'truncated'
          : 'rejected';
    }
  } catch (error) {
    status = failure(error, stats);
  }
  return { status, accepted, payload, answer, toolCalls: toolCalls(stats.rawResponses), ...stats };
}

async function run(output, models) {
  if (git(['status', '--porcelain', '--', 'src', 'bench', 'package.json'])) {
    throw new Error('Commit the benchmark source before running it');
  }
  const sdkPath = path.dirname(require.resolve('@anthropic-ai/sdk'));
  const manifest = {
    kind: KIND,
    date: new Date().toISOString(),
    sdkCommit: git(['rev-parse', 'HEAD']),
    anthropicSdk: JSON.parse(fs.readFileSync(path.join(sdkPath, 'package.json'), 'utf8')).version,
    node: process.version,
    models,
    arms: ARMS,
    maxTokens,
    timeoutMs: timeout,
    transportRetries: 0,
    temperature: null,
    thinking: 'provider default',
    effort: 'provider default',
    budget: { structured: 1, tool: 3 },
    taskSha256,
    tasks: tasks.length
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ manifest })}\n`, { flag: 'wx' });
  for (const model of models) {
    for (const [index, task] of tasks.entries()) {
      for (const arm of index % 2 ? [...ARMS].reverse() : ARMS) {
        const started = Date.now();
        const result = await (arm === 'sdk' ? sdk(task, model) : direct(task, model));
        const correct = score(task, result.payload, result.toolCalls, result.answer);
        const row = {
          model,
          taskId: task.id,
          category: task.category,
          arm,
          correct,
          silentWrong: result.accepted && !correct,
          wallMs: Date.now() - started,
          ...result
        };
        fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        console.log(`${model} ${task.id} ${arm}: ${correct ? 'correct' : result.status}`);
      }
    }
  }
  report(output);
}

// Verifies a result file against the current tasks and scorer, then prints
// correct answers per model, arm and category.
function report(file) {
  const [header, ...rows] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const { manifest } = header;
  if (manifest?.kind !== KIND) throw new Error(`Not an ${KIND} result file`);
  if (manifest.taskSha256 !== taskSha256) {
    throw new Error('Task definitions changed since this run');
  }
  git(['cat-file', '-e', `${manifest.sdkCommit}^{commit}`]);
  // Exactly one row per model, task and arm, each re-scored against the
  // current gold answers; duplicates cannot stand in for missing tasks.
  const byId = new Map(tasks.map(task => [task.id, task]));
  const seen = new Set();
  for (const row of rows) {
    const task = byId.get(row.taskId);
    const key = `${row.model}\0${row.taskId}\0${row.arm}`;
    if (
      !task ||
      !manifest.models.includes(row.model) ||
      !ARMS.includes(row.arm) ||
      row.category !== task.category ||
      seen.has(key)
    ) {
      throw new Error(`Unexpected row ${row.model} ${row.taskId} ${row.arm}`);
    }
    seen.add(key);
    const correct = score(task, row.payload, row.toolCalls, row.answer);
    if (correct !== row.correct || row.silentWrong !== (row.accepted && !correct)) {
      throw new Error(`Score mismatch for ${row.model} ${row.taskId} ${row.arm}`);
    }
  }
  if (seen.size !== manifest.models.length * tasks.length * ARMS.length) {
    throw new Error('Incomplete run: expected one row per model, task and arm');
  }
  const categories = [...new Set(tasks.map(task => task.category))];
  console.log(`Source ${manifest.sdkCommit}, ${manifest.date}, max_tokens ${manifest.maxTokens}`);
  for (const model of manifest.models) {
    for (const arm of ARMS) {
      const own = rows.filter(row => row.model === model && row.arm === arm);
      const cells = categories.map(category => {
        const matching = own.filter(row => row.category === category);
        return `${category} ${matching.filter(row => row.correct).length}/${matching.length}`;
      });
      const silent = own.filter(row => row.silentWrong).length;
      console.log(`${model} ${arm}: ${cells.join(', ')}; silently wrong ${silent}`);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const models = (process.env.NULLPROTOCOL_BENCH_MODELS || 'claude-opus-5').split(',');
  const output =
    args[0] ||
    path.join(
      __dirname,
      'results',
      `frozen-anthropic-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    );
  const work = async () => (args[0] === '--report' ? report(args[1]) : run(output, models));
  work().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { report };
