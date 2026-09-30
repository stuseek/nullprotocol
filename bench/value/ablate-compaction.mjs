#!/usr/bin/env node
// Offline compaction ablation on captured, unchanged sources. Each picked
// exchange is replayed against the same local model with:
//   base – the SDK's compaction prompt, as captured;
//   A    – a support-benchmark prompt that keeps facts about the customer
//          (not a universal SDK prompt: other Agents need other facts);
//   B    – the base prompt plus one repair turn naming the exact problem;
//   C    – the same 16 sources in two halves of 8; calls, tokens and
//          coverage count for the whole original chunk, and the chunk only
//          counts as compacted when both halves are valid;
//   AB   – A plus one repair turn.
//
//   node bench/value/ablate-compaction.mjs CAPTURE.jsonl OUT.jsonl [--picks 0,2,5,9,10,11] [--reps 2]
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedFacts, problemText, reason, statedFacts } from './compaction-checks.mjs';
import { modelURL } from './arms.mjs';

const require = createRequire(import.meta.url);
const { memoryCase } = require('./memory');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [capture, out] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const picks = option('--picks', '0,2,5,9,10,11').split(',').map(Number);
const reps = Number(option('--reps', '2'));
const VARIANTS = ['base', 'A', 'B', 'C', 'AB'];
// The captured runs used memory case seed 0.
const customer = memoryCase(0, 30).customer;

const supportPrompt =
  'Compact the supplied support conversation records into JSON only: {"facts":[{"value":{},"sourceSeqs":[1]}],"summary":"..."}. Facts are about the customer and their requests: identity, location, order numbers with their current status, preferences, constraints such as allergies, corrections (say which value is current), and commitments made to them. Do not record product descriptions or catalogue details as facts. Use at most 5 facts; each value is a flat object of short strings or numbers. Each fact must cite source sequence numbers from these records. Never infer an action outcome from a request. The summary must be brief and must preserve the meaning of the previous summary.';

async function call(model, messages, stats) {
  const started = Date.now();
  const response = await fetch(`${modelURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 1024 })
  });
  const data = await response.json();
  stats.calls++;
  stats.ms += Date.now() - started;
  stats.inputTokens += data.usage?.prompt_tokens ?? 0;
  stats.outputTokens += data.usage?.completion_tokens ?? 0;
  return data.choices?.[0]?.message?.content ?? '';
}

// One compaction of `sources`, optionally with the support prompt and one repair.
async function compact(model, system, previousSummary, sources, repair, stats) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ previousSummary, sources }) }
  ];
  let content = await call(model, messages, stats);
  let result = reason(content, sources);
  if (repair && result.reason !== 'valid') {
    content = await call(
      model,
      [
        ...messages,
        { role: 'assistant', content },
        {
          role: 'user',
          content: `${problemText(result, sources)} Answer again with only the corrected JSON.`
        }
      ],
      stats
    );
    result = reason(content, sources);
  }
  return { ...result, content };
}

async function run(record, variant) {
  const { model, messages } = record.request;
  const { previousSummary, sources } = JSON.parse(messages[1].content);
  const system = variant === 'A' || variant === 'AB' ? supportPrompt : messages[0].content;
  const repair = variant === 'B' || variant === 'AB';
  const stats = { calls: 0, ms: 0, inputTokens: 0, outputTokens: 0 };
  let valid;
  let facts = [];
  let salvaged = [];
  let reasons;
  if (variant === 'C' && sources.length > 8) {
    const half = Math.ceil(sources.length / 2);
    const first = await compact(
      model,
      system,
      previousSummary,
      sources.slice(0, half),
      false,
      stats
    );
    const second = await compact(
      model,
      system,
      first.reason === 'valid' ? first.parsed.summary : previousSummary,
      sources.slice(half),
      false,
      stats
    );
    reasons = [first.reason, second.reason];
    valid = first.reason === 'valid' && second.reason === 'valid';
    const parts = [first, second]
      .filter(part => part.reason === 'valid')
      .flatMap(part => part.parsed.facts);
    // Facts from one valid half are salvage: the chunk does not advance.
    if (valid) facts = parts;
    else salvaged = parts;
  } else {
    const result = await compact(model, system, previousSummary, sources, repair, stats);
    reasons = [result.reason];
    valid = result.reason === 'valid';
    if (valid) facts = result.parsed.facts;
  }
  const expected = expectedFacts(sources, customer);
  const accepted = statedFacts(facts, customer);
  return {
    valid,
    reasons,
    ...stats,
    factCount: facts.length,
    expected,
    covered: accepted.stated.filter(fact => expected.includes(fact)),
    wrongFacts: accepted.wrong,
    salvagedCovered: statedFacts(salvaged, customer).stated.filter(fact => expected.includes(fact)),
    facts
  };
}

const records = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
appendFileSync(
  out,
  `${JSON.stringify({
    manifest: {
      kind: 'compaction-ablation-v1',
      capture: path.basename(capture),
      picks,
      reps,
      variants: VARIANTS,
      commit: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain', '--', 'bench/value', 'src'])),
      modelURL,
      note: 'A is a support-benchmark prompt, not a proposed SDK default.'
    }
  })}\n`
);
for (const pick of picks) {
  const record = records[pick];
  const sources = JSON.parse(record.request.messages[1].content).sources;
  const baseline = reason(JSON.parse(record.text).choices[0].message.content, sources);
  for (let rep = 0; rep < reps; rep++) {
    for (const variant of VARIANTS) {
      const row = {
        pick,
        model: record.model,
        seq: `${sources[0].seq}-${sources.at(-1).seq}`,
        baseline: baseline.reason,
        variant,
        rep,
        ...(await run(record, variant))
      };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(
        `#${pick} ${record.model} ${variant} r${rep}: ${row.valid ? 'valid' : row.reasons.join('+')} covered ${row.covered.join(',') || '-'}/${row.expected.join(',') || '-'} wrong ${row.wrongFacts} calls ${row.calls} ${row.ms}ms`
      );
    }
  }
}
