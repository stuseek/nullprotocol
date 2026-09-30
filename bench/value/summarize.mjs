#!/usr/bin/env node
// Paired table for a short-case pilot file:
//   node bench/value/summarize.mjs bench/results/value-short-1.jsonl
import { readFileSync } from 'node:fs';

const [header, ...rows] = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
console.log(
  `${header.manifest.kind} ${header.manifest.sdkCommit.slice(0, 7)} reps ${header.manifest.reps}`
);

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const ms = row => row.ms ?? (row.modelCalls || []).reduce((total, call) => total + call.ms, 0);
const groups = new Map();
for (const row of rows) {
  const key = `${row.model}\t${row.case}\t${row.arm}`;
  groups.set(key, [...(groups.get(key) || []), row]);
}

console.log(
  'model\tcase\tarm\teffects\tcontent t/f/review\tanswered\textraRefunds\tattempts\terrors\tmedianMs'
);
for (const [key, group] of groups) {
  const count = predicate => group.filter(predicate).length;
  const extra = group.reduce(
    (total, row) =>
      total +
      row.executions.filter(e => !(row.case === 'A1' && e.orderId === '2210' && e.amount === 89))
        .length +
      Math.max(0, row.executions.filter(e => row.case === 'A1' && e.orderId === '2210').length - 1),
    0
  );
  const errors = [...new Set(group.map(row => row.errorCode).filter(Boolean))].join(',') || '-';
  console.log(
    [
      key,
      `${count(row => row.effectsCorrect)}/${group.length}`,
      `${count(row => row.contentCorrect === true)}/${count(row => row.contentCorrect === false)}/${count(row => row.contentCorrect === null)}`,
      `${count(row => row.answered)}/${group.length}`,
      extra,
      group.reduce((total, row) => total + row.refundAttempts, 0),
      errors,
      median(group.map(ms))
    ].join('\t')
  );
}
