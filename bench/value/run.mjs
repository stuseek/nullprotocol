#!/usr/bin/env node
// Exploratory pilot: the same support cases through three arms on the same
// local model alias and generation settings (max_tokens 1024, provider
// defaults otherwise, no seed):
//   raw  – diagnostic: native tool loop, JSON.parse arguments, no schema
//          checks, no policy guard;
//   app  – an ordinary competent app: native tool loop with the same limits
//          as the executor (4 model calls, 8 actions), JSON recovery, schema
//          checks, the shop's policy guard and idempotent handler, and
//          persistent history;
//   np   – a managed Agent on an in-process API with ManagedExecutor.
//
//   node --env-file=../nullprotocol-api/.env bench/value/run.mjs \
//     [--models np-value-q3,np-value-q7] [--reps 3] [--out FILE]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localSpace } from '../../scripts/local-space.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const { parseJSON } = require('../../src/json');
const { NullProtocolClient, ManagedExecutor, defineAction } = require('../../src');
const { contracts, createShop, instructions } = require('./shop');
const { shortCases, scoreContent } = require('./scenarios');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modelURL = process.env.MODEL_BASE_URL || 'http://127.0.0.1:11434/v1';
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const models = option('--models', 'np-value-q3,np-value-q7').split(',');
const reps = Number(option('--reps', '3'));
const out = option(
  '--out',
  path.join(
    root,
    'bench/results',
    `value-pilot-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  )
);
const review = out.replace(/\.jsonl$/, '.review.jsonl');
const ARMS = ['raw', 'app', 'np'];

const ajv = new Ajv({ allErrors: true, strict: false });
const validateInput = Object.fromEntries(
  Object.values(contracts).map(contract => [contract.name, ajv.compile(contract.input)])
);
const toolSpecs = Object.values(contracts).map(contract => ({
  type: 'function',
  function: { name: contract.name, description: contract.description, parameters: contract.input }
}));

async function chat(model, messages) {
  const body = JSON.stringify({ model, messages, max_tokens: 1024, tools: toolSpecs });
  const started = Date.now();
  const response = await fetch(`${modelURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message || `HTTP ${response.status}`), {
      code: response.status === 400 ? 'unsupported' : 'model_error'
    });
  }
  return {
    message: data.choices[0].message,
    usage: data.usage,
    ms: Date.now() - started,
    requestBytes: Buffer.byteLength(body)
  };
}

function runTool(call, shop, competent, idempotencyKey) {
  const name = call.function?.name;
  if (!contracts[name]) return { error: `unknown tool ${name}` };
  let args;
  try {
    args = competent ? parseJSON(call.function.arguments) : JSON.parse(call.function.arguments);
  } catch {
    return { error: 'arguments are not valid JSON' };
  }
  if (competent && !validateInput[name](args)) {
    return { error: `invalid arguments: ${ajv.errorsText(validateInput[name].errors)}` };
  }
  if (name === 'refund' && competent && !shop.guard(args)) {
    return { error: 'refund not allowed by policy' };
  }
  if (name === 'refund' && !competent) shop.attempts.push(args);
  return name === 'refund' ? shop.refund(args, { idempotencyKey }) : shop.getOrder(args);
}

// raw and app share this loop; `competent` adds recovery, schemas and the guard.
async function directTurn({ model, history, shop, text, competent, key }) {
  history.push({ role: 'user', content: text });
  const calls = [];
  const toolErrors = [];
  let actions = 0;
  for (let turn = 0; turn < 4; turn++) {
    const reply = await chat(model, [{ role: 'system', content: instructions }, ...history]);
    calls.push({
      usage: reply.usage,
      ms: reply.ms,
      requestBytes: reply.requestBytes,
      message: reply.message
    });
    const toolCalls = reply.message.tool_calls || [];
    history.push({
      role: 'assistant',
      content: reply.message.content || '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
    if (!toolCalls.length)
      return { answer: reply.message.content || null, modelCalls: calls, toolErrors };
    for (const call of toolCalls) {
      if (++actions > 8)
        return { answer: null, errorCode: 'tool_limit', modelCalls: calls, toolErrors };
      const result = runTool(call, shop, competent, `${key}:${actions}`);
      if (result.error) toolErrors.push(result.error);
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { answer: null, errorCode: 'tool_limit', modelCalls: calls, toolErrors };
}

// One managed Agent per model; its handlers act on whichever shop is current.
async function managed(model) {
  const space = await localSpace([
    'templates:write',
    'agents:write',
    'agents:read',
    'runs:create',
    'runs:read',
    'conversations:read'
  ]);
  const holder = { shop: null };
  const actions = [
    defineAction({ ...contracts.getOrder, handler: args => holder.shop.getOrder(args) }),
    defineAction({
      ...contracts.refund,
      guard: args => holder.shop.guard(args),
      handler: (args, context) => holder.shop.refund(args, context)
    })
  ];
  const client = new NullProtocolClient({ spaceKey: space.appKey, endpoint: space.endpoint });
  const { template } = await client.templates.create({
    name: `Value pilot ${model}`,
    config: {
      instructions,
      model: { provider: 'local', model, credentialRef: 'model' },
      actions,
      memory: { mode: 'conversation' }
    }
  });
  const { agent } = await client.agents.create({ templateId: template.id });
  const executor = new ManagedExecutor({
    executorKey: space.executorKey,
    endpoint: space.endpoint,
    agentIds: [agent.id],
    actions,
    credentials: { model: { provider: 'local', baseURL: modelURL } }
  });
  await executor.start();
  return {
    holder,
    async turn(text, conversation) {
      const started = Date.now();
      const run = await client.agent(agent.id).run(text, { conversation });
      const { steps } = await client.agent(agent.id).listSteps(run.id);
      return {
        answer: run.status === 'succeeded' ? (run.output?.text ?? null) : null,
        errorCode: run.errorCode ?? null,
        runStatus: run.status,
        usage: run.usage ?? null,
        ms: Date.now() - started,
        toolErrors: steps
          .filter(step => step.status === 'failed' || step.payload?.allowed === false)
          .map(step => step.payload?.errorCode || step.payload?.reasonCode || step.kind),
        steps
      };
    },
    async close() {
      await executor.stop();
      await space.cleanup();
    }
  };
}

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(path.dirname(out), { recursive: true });
appendFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      kind: 'value-pilot-short-v1',
      exploratory: true,
      date: new Date().toISOString(),
      sdkCommit: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain', '--', 'src', 'bench/value'])),
      casesSha256: createHash('sha256')
        .update(JSON.stringify(shortCases.map(({ id, turns }) => ({ id, turns }))))
        .digest('hex'),
      models,
      arms: ARMS,
      reps,
      generation: { max_tokens: 1024, temperature: 'provider default', generationSeed: null },
      modelURL
    }
  })}\n`
);

for (const model of models) {
  const np = await managed(model);
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const [index, testCase] of shortCases.entries()) {
        // Rotate arm order so no arm always runs on a warm model first.
        const order = ARMS.map((_, i) => ARMS[(i + index + rep) % ARMS.length]);
        for (const arm of order) {
          const shop = createShop();
          const key = `c-${testCase.id}-${rep}`;
          let result;
          try {
            if (arm === 'np') {
              np.holder.shop = shop;
              result = await np.turn(testCase.turns[0], key);
            } else {
              result = await directTurn({
                model,
                history: [],
                shop,
                text: testCase.turns[0],
                competent: arm === 'app',
                key
              });
            }
          } catch (error) {
            result = { answer: null, errorCode: error.code || error.message };
          }
          const effects = testCase.effects({ calls: shop.calls, executions: shop.executions });
          const contentCorrect = scoreContent(testCase, result.answer);
          // A neutral id lets answers be reviewed without seeing model or arm.
          const reviewId = createHash('sha256')
            .update(`${out}:${model}:${arm}:${testCase.id}:${rep}`)
            .digest('hex')
            .slice(0, 10);
          const row = {
            model,
            arm,
            case: testCase.id,
            kind: testCase.kind,
            fixtureSeed: rep,
            reviewId,
            effectsCorrect: effects,
            contentCorrect,
            reviewRequired: contentCorrect === null,
            answered: Boolean(result.answer),
            executions: shop.executions,
            refundAttempts: shop.attempts.length,
            calls: shop.calls,
            ...result
          };
          appendFileSync(
            review,
            `${JSON.stringify({ reviewId, case: testCase.id, customer: testCase.turns[0], answer: result.answer })}\n`
          );
          appendFileSync(out, `${JSON.stringify(row)}\n`);
          console.log(
            `${model} ${testCase.id} r${rep} ${arm}: effects ${effects ? 'ok' : 'miss'}, content ${contentCorrect}${row.errorCode ? ` (${row.errorCode})` : ''}`
          );
        }
      }
    }
  } finally {
    await np.close();
  }
}
console.log(out);
