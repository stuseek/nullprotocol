#!/usr/bin/env node
// Exploratory memory pilot. Arms on the same model alias and generation
// settings:
//   raw          – full history every turn (the model server clips it);
//   app-window   – newest messages that fit the model's context;
//   app-summary  – at 30 messages or a full window, the same model
//                  summarizes older messages, told to keep exact business
//                  facts and corrections; summary + last 12 messages are sent;
//   np           – a managed Agent with conversation memory.
// Every model call records prompt tokens; a call at the context limit is
// marked clipped.
//
//   node --env-file=../nullprotocol-api/.env bench/value/run-memory.mjs \
//     [--models np-value-q3,np-value-q7] [--reps 2] [--fillers 3,40] [--out FILE]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, generation, managedAgents, modelURL } from './arms.mjs';

const require = createRequire(import.meta.url);
const { instructions, memoryCase, scoreProbe, scoreIsolation } = require('./memory');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const models = option('--models', 'np-value-q3,np-value-q7').split(',');
const reps = Number(option('--reps', '2'));
const fillerCounts = option('--fillers', '3,40').split(',').map(Number);
const out = option(
  '--out',
  path.join(
    root,
    'bench/results',
    `value-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  )
);
const review = out.replace(/\.jsonl$/, '.review.jsonl');
const ARMS = ['raw', 'app-window', 'app-summary', 'np'];
const CONTEXT = 8192;
// Prompt tokens the model can see while leaving room for the answer.
const BUDGET = CONTEXT - 1024 - 256;

const summaryInstructions =
  'Summarize the earlier part of this customer support conversation for the assistant who continues it. Keep exact business facts word for word: the customer name, order numbers, allergies, city, and any later corrections, saying which value is current. Be brief.';

function directState() {
  return { messages: [], summary: null, bytesPerToken: 3.5, calls: [] };
}

const estimate = (state, messages) =>
  Buffer.byteLength(JSON.stringify(messages)) / state.bytesPerToken;

function system(state) {
  return {
    role: 'system',
    content: state.summary
      ? `${instructions}\n\nConversation summary so far:\n${state.summary}`
      : instructions
  };
}

async function call(model, state, messages, purpose) {
  const reply = await chat(model, messages);
  const promptTokens = reply.usage?.prompt_tokens ?? null;
  const clipped = promptTokens !== null && promptTokens >= CONTEXT - 64;
  // Calibrate the byte estimate only from calls the server saw in full.
  if (promptTokens && !clipped) state.bytesPerToken = reply.requestBytes / promptTokens;
  state.calls.push({
    purpose,
    promptTokens,
    completionTokens: reply.usage?.completion_tokens ?? null,
    requestBytes: reply.requestBytes,
    clipped,
    ms: reply.ms
  });
  return reply.message.content || '';
}

async function summarize(model, state) {
  const older = state.messages.slice(0, -12);
  const transcript = older.map(message => `${message.role}: ${message.content}`).join('\n');
  state.summary = await call(
    model,
    state,
    [
      { role: 'system', content: summaryInstructions },
      {
        role: 'user',
        content: `${state.summary ? `Summary so far:\n${state.summary}\n\n` : ''}Messages to add:\n${transcript}`
      }
    ],
    'summary'
  );
  state.messages = state.messages.slice(-12);
}

async function directTurn(arm, model, state, text) {
  state.messages.push({ role: 'user', content: text });
  if (
    arm === 'app-summary' &&
    (state.messages.length >= 30 || estimate(state, [system(state), ...state.messages]) > BUDGET)
  ) {
    await summarize(model, state);
  }
  let window = state.messages;
  if (arm !== 'raw') {
    while (window.length > 1 && estimate(state, [system(state), ...window]) > BUDGET) {
      window = window.slice(1);
    }
  }
  const answer = await call(model, state, [system(state), ...window], 'answer');
  state.messages.push({ role: 'assistant', content: answer });
  return answer;
}

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(path.dirname(out), { recursive: true });
appendFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      kind: 'value-pilot-memory-v1',
      exploratory: true,
      date: new Date().toISOString(),
      sdkCommit: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain', '--', 'src', 'bench/value'])),
      models,
      arms: ARMS,
      reps,
      fillerCounts,
      context: CONTEXT,
      budget: BUDGET,
      generation,
      modelURL
    }
  })}\n`
);

for (const model of models) {
  const np = await managedAgents(model, [{ name: 'memory', instructions }]);
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const [index, fillers] of fillerCounts.entries()) {
        const testCase = memoryCase(rep, fillers);
        const order = ARMS.map((_, i) => ARMS[(i + index + rep) % ARMS.length]);
        for (const arm of order) {
          const key = `c${rep}${index}`;
          const started = Date.now();
          const turns = [];
          let probe;
          let isolation;
          try {
            if (arm === 'np') {
              for (const text of testCase.turns) {
                const result = await np.turn('memory', text, key);
                turns.push({
                  answered: Boolean(result.answer),
                  errorCode: result.errorCode,
                  usage: result.usage,
                  steps: result.steps.map(step => ({
                    kind: step.kind,
                    status: step.status,
                    payload: step.payload
                  }))
                });
              }
              probe = await np.turn('memory', testCase.probe, key);
              isolation = await np.turn('memory', testCase.isolation, `${key}-other`);
              probe.memoryState = (await np.conversation('memory', key)).conversation.memoryState;
            } else {
              const state = directState();
              for (const text of testCase.turns)
                turns.push({ answer: await directTurn(arm, model, state, text) });
              probe = { answer: await directTurn(arm, model, state, testCase.probe) };
              isolation = {
                answer: await directTurn(arm, model, directState(), testCase.isolation)
              };
              probe.calls = state.calls;
              probe.summary = state.summary;
            }
          } catch (error) {
            probe = { answer: null, errorCode: error.code || error.message };
          }
          const reviewId = createHash('sha256')
            .update(`${out}:${model}:${arm}:${testCase.id}`)
            .digest('hex')
            .slice(0, 10);
          const facts = scoreProbe(testCase.customer, probe.answer);
          const row = {
            model,
            arm,
            case: testCase.id,
            fillers,
            fixtureSeed: rep,
            reviewId,
            facts,
            isolated: scoreIsolation(testCase.customer, isolation?.answer),
            probeAnswer: probe.answer ?? null,
            isolationAnswer: isolation?.answer ?? null,
            errorCode: probe.errorCode ?? null,
            ms: Date.now() - started,
            modelCalls: probe.calls ?? null,
            summary: probe.summary ?? null,
            memoryState: probe.memoryState ?? null,
            turns
          };
          appendFileSync(out, `${JSON.stringify(row)}\n`);
          appendFileSync(
            review,
            `${JSON.stringify({ reviewId, probe: testCase.probe, answer: row.probeAnswer })}\n`
          );
          console.log(
            `${model} ${testCase.id} ${arm}: ${JSON.stringify(facts)} isolated ${row.isolated}`
          );
        }
      }
    }
  } finally {
    await np.close();
  }
}
console.log(out);
