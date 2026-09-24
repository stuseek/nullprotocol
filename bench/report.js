#!/usr/bin/env node
/* eslint-disable no-console -- This CLI prints the pilot summary. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { score } = require('./score');

const file = process.argv[2];
if (!file) {
  throw new Error('Usage: npm run bench:report -- PATH_TO_JSONL');
}
const [header, ...rows] = fs
  .readFileSync(path.resolve(file), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const manifest = header.manifest;
const frozen = manifest?.suite === 'frozen';
const tasks = require(frozen ? './frozen-tasks' : './tasks');
if (manifest?.taskSha256 !== createHash('sha256').update(JSON.stringify(tasks)).digest('hex')) {
  throw new Error('Task definitions changed since this benchmark was run');
}
if (
  frozen &&
  (manifest.kind !== 'local-frozen-v1' || manifest.sourceDirty || !manifest.sdkCommit)
) {
  throw new Error('Frozen run did not record a clean source commit');
}
if (frozen) {
  const root = path.resolve(__dirname, '..');
  const sourceHash = createHash('sha256');
  for (const file of manifest.sourceFiles || []) {
    if (
      typeof file !== 'string' ||
      (!file.startsWith('src/') && !file.startsWith('bench/') && file !== 'package.json') ||
      file.split('/').includes('..')
    ) {
      throw new Error('Invalid source file in manifest');
    }
    sourceHash.update(file).update(fs.readFileSync(path.join(root, file)));
  }
  if (sourceHash.digest('hex') !== manifest.sourceSha256) {
    throw new Error('Benchmark source changed since this run');
  }
  const commit = execFileSync('git', ['rev-parse', manifest.sdkCommit], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
  if (commit !== manifest.sdkCommit) {
    throw new Error('Unknown source commit');
  }
}
const armsFor = task => {
  return frozen && task.category !== 'tool' ? ['direct', 'direct-json', 'sdk'] : ['direct', 'sdk'];
};
const expectedRows =
  manifest?.models.length * tasks.reduce((total, task) => total + armsFor(task).length, 0);
if (!manifest || rows.length !== expectedRows) {
  throw new Error('Incomplete benchmark: expected one result per model, task, and arm');
}
const seen = new Set();
for (const row of rows) {
  const key = `${row.model}/${row.taskId}/${row.arm}`;
  if (seen.has(key)) {
    throw new Error(`Duplicate result: ${key}`);
  }
  seen.add(key);
  const task = tasks.find(item => item.id === row.taskId && item.category === row.category);
  if (
    !manifest.models.some(item => item.name === row.model) ||
    !task ||
    !armsFor(task).includes(row.arm)
  ) {
    throw new Error(`Unexpected result: ${key}`);
  }
  if (frozen) {
    const correct = score(task, row.payload, row.toolCalls, row.answer);
    if (row.correct !== correct || row.silentWrong !== (row.accepted && !correct)) {
      throw new Error(`Scoring mismatch: ${key}`);
    }
  }
}

function wilson(correct, total) {
  if (!total) {
    return 'n/a';
  }
  const z = 1.96;
  const p = correct / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const radius = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return `${(100 * (center - radius)).toFixed(0)}–${(100 * (center + radius)).toFixed(0)}%`;
}

console.log(
  `${manifest.suite || 'pilot'}: ${manifest.date}; ${tasks.length} tasks/model; one sample per arm`
);
console.log('Correct is gold-scored. Accepted has a different contract in each arm.');
for (const model of manifest.models) {
  console.log(`\n${model.name} (${model.digest?.slice(0, 12) || 'unknown digest'})`);
  for (const category of ['extract', 'decide', 'tool', 'long-context', 'retrieval']) {
    for (const arm of manifest.arms) {
      const group = rows.filter(
        row => row.model === model.name && row.category === category && row.arm === arm
      );
      if (!group.length) {
        continue;
      }
      const count = field => group.filter(row => row[field]).length;
      const sum = field => group.reduce((total, row) => total + (row[field] || 0), 0);
      const statuses =
        [...new Set(group.filter(row => row.status !== 'ok').map(row => row.status))].join(',') ||
        'none';
      console.log(
        `${category.padEnd(12)} ${arm.padEnd(11)} correct ${count('correct')}/${group.length} (Wilson 95% ${wilson(count('correct'), group.length)}); silently wrong ${count('silentWrong')}; accepted ${count('accepted')}; calls ${sum('calls')}; reported tokens ${sum('promptTokens') + sum('completionTokens')}; other statuses ${statuses}`
      );
    }
  }
  if (frozen) {
    for (const baseline of ['direct', 'direct-json']) {
      const paired = tasks
        .filter(task => armsFor(task).includes(baseline))
        .map(task => {
          const sdk = rows.find(
            row => row.model === model.name && row.taskId === task.id && row.arm === 'sdk'
          );
          const base = rows.find(
            row => row.model === model.name && row.taskId === task.id && row.arm === baseline
          );
          const rawText = row => row.rawResponses.map(item => item.message?.content);
          return {
            id: task.id,
            sdk: sdk.correct,
            base: base.correct,
            structured: task.category !== 'tool',
            sameText:
              task.category !== 'tool' &&
              sdk.rawResponses.length > 0 &&
              base.rawResponses.length > 0 &&
              JSON.stringify(rawText(sdk)) === JSON.stringify(rawText(base))
          };
        });
      const gained = paired.filter(pair => !pair.base && pair.sdk);
      const lost = paired.filter(pair => pair.base && !pair.sdk);
      console.log(
        `${baseline} vs SDK: baseline wrong / SDK right ${gained.length} [${gained.map(pair => pair.id).join(', ')}]; baseline right / SDK wrong ${lost.length} [${lost.map(pair => pair.id).join(', ')}]; identical raw text ${paired.filter(pair => pair.sameText).length}/${paired.filter(pair => pair.structured).length} structured pairs`
      );
    }
  }
}
console.log(
  '\nTask-specific sample only. Wilson ranges treat correlated synthetic tasks as independent and are descriptive, not population intervals. Read raw rows before interpreting differences.'
);
