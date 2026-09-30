#!/usr/bin/env node
// Re-scores saved memory probe answers with the per-fact scorer and sets any
// manual review beside it. The results file is only read; the rescore is a
// separate artifact recording the scorer version and every input's hash.
//
//   node bench/value/rescore-memory.mjs OUT.jsonl RESULTS.jsonl... [--review REVIEW.jsonl]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { memoryCase } = require('./memory');
const { VERSION, scoreProbe } = require('./memory-score');

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const lines = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

const args = process.argv.slice(2);
const reviewAt = args.indexOf('--review');
const reviewFile = reviewAt === -1 ? null : args[reviewAt + 1];
const [out, ...inputs] = args.filter(
  (_, index) => reviewAt === -1 || (index !== reviewAt && index !== reviewAt + 1)
);
const manual = new Map((reviewFile ? lines(reviewFile) : []).map(row => [row.reviewId, row]));
const FACTS = ['name', 'order', 'allergy', 'city'];

const rows = [];
for (const file of inputs) {
  const [{ manifest }, ...results] = lines(file);
  for (const result of results) {
    const { customer } = memoryCase(result.fixtureSeed, result.fillers);
    const review = manual.get(result.reviewId);
    rows.push({
      file: path.basename(file),
      complete:
        manifest.reps *
        manifest.fillerCounts.length *
        manifest.arms.length *
        manifest.models.length,
      reviewId: result.reviewId,
      model: result.model,
      arm: result.arm,
      case: result.case,
      fillers: result.fillers,
      auto: scoreProbe(customer, result.probeAnswer),
      manual: review ? Object.fromEntries(FACTS.map(fact => [fact, review[fact]])) : null,
      manualNote: review?.note ?? null,
      isolated: result.isolated,
      errorCode: result.errorCode,
      turnFailures: result.turnFailures ?? [],
      compactionSteps: result.turns
        .flatMap(turn => turn.steps || [])
        .filter(step => step.kind === 'compaction').length,
      compactionFailed: result.turns
        .flatMap(turn => turn.steps || [])
        .filter(step => step.kind === 'compaction' && step.status !== 'succeeded').length
    });
  }
}

const header = {
  kind: 'value-memory-rescore',
  scorer: VERSION,
  scorerSha256: sha(path.join(here, 'memory-score.js')),
  inputs: inputs.map(file => ({ file: path.basename(file), sha256: sha(file) })),
  review: reviewFile ? { file: path.basename(reviewFile), sha256: sha(reviewFile) } : null
};
writeFileSync(out, [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');

// Recall per field, automatic and manual kept apart; disagreements listed.
const cell = (group, source, fact) => {
  const scored = group.filter(row => row[source]);
  if (!scored.length) return '-';
  const count = value => scored.filter(row => row[source][fact] === value).length;
  return `${count(true)}/${scored.length}${count(null) ? ` (${count(null)}?)` : ''}`;
};
const groups = new Map();
for (const row of rows) {
  const key = `${row.file}\t${row.model}\t${row.fillers}\t${row.arm}`;
  groups.set(key, [...(groups.get(key) || []), row]);
}
console.log(`${VERSION} ${header.scorerSha256.slice(0, 12)}`);
console.log(
  [
    'file',
    'model',
    'fillers',
    'arm',
    ...FACTS.map(f => `auto:${f}`),
    ...FACTS.map(f => `manual:${f}`),
    'isolated',
    'compaction(failed)'
  ].join('\t')
);
for (const [key, group] of groups) {
  console.log(
    [
      key,
      ...FACTS.map(fact => cell(group, 'auto', fact)),
      ...FACTS.map(fact => cell(group, 'manual', fact)),
      `${group.filter(row => row.isolated === true).length}/${group.length}`,
      `${group.reduce((t, r) => t + r.compactionSteps, 0)}(${group.reduce((t, r) => t + r.compactionFailed, 0)})`
    ].join('\t')
  );
}
const disagreements = rows.flatMap(row =>
  row.manual
    ? FACTS.filter(fact => row.auto[fact] !== row.manual[fact]).map(
        fact => `${row.reviewId} ${fact}: auto ${row.auto[fact]} manual ${row.manual[fact]}`
      )
    : []
);
console.log(`\nauto vs manual disagreements: ${disagreements.length}`);
for (const line of disagreements) console.log(`  ${line}`);
