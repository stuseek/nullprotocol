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
import { chat, generation, managedAgents, modelURL } from './arms.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const { parseJSON } = require('../../src/json');
const { defineAction } = require('../../src');
const { contracts, createShop, instructions } = require('./shop');
const { shortCases, scoreContent } = require('./scenarios');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const models = option('--models', 'np-value-q3,np-value-q7').split(',');
const reps = Number(option('--reps', '3'));
const caseIds = option('--cases', shortCases.map(testCase => testCase.id).join(',')).split(',');
const cases = shortCases.filter(testCase => caseIds.includes(testCase.id));
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
    const reply = await chat(
      model,
      [{ role: 'system', content: instructions }, ...history],
      toolSpecs
    );
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

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(path.dirname(out), { recursive: true });
appendFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      kind: 'value-pilot-short-v2',
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
      cases: caseIds,
      generation,
      modelURL
    }
  })}\n`
);

for (const model of models) {
  // The managed handlers act on whichever shop the current case uses.
  const holder = { shop: null };
  const np = await managedAgents(model, [
    {
      name: 'shop',
      instructions,
      actions: [
        defineAction({ ...contracts.getOrder, handler: args => holder.shop.getOrder(args) }),
        defineAction({
          ...contracts.refund,
          guard: args => holder.shop.guard(args),
          handler: (args, context) => holder.shop.refund(args, context)
        })
      ]
    }
  ]);
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const [index, testCase] of cases.entries()) {
        // Rotate arm order so no arm always runs on a warm model first.
        const order = ARMS.map((_, i) => ARMS[(i + index + rep) % ARMS.length]);
        for (const arm of order) {
          const shop = createShop();
          const key = `c-${testCase.id}-${rep}`;
          let result;
          try {
            if (arm === 'np') {
              holder.shop = shop;
              result = await np.turn('shop', testCase.turns[0], key);
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
