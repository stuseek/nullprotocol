#!/usr/bin/env node
/* eslint-disable no-console -- This CLI prints the pilot summary. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const tasks = require('./tasks');

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
if (manifest?.taskSha256 !== createHash('sha256').update(JSON.stringify(tasks)).digest('hex')) {
  throw new Error('Task definitions changed since this pilot was run');
}
if (!manifest || rows.length !== manifest.models.length * tasks.length * 2) {
  throw new Error('Incomplete pilot: expected one result per model, task, and arm');
}
const seen = new Set();
for (const row of rows) {
  const key = `${row.model}/${row.taskId}/${row.arm}`;
  if (seen.has(key)) {
    throw new Error(`Duplicate result: ${key}`);
  }
  seen.add(key);
  if (
    !manifest.models.some(item => item.name === row.model) ||
    !tasks.some(item => item.id === row.taskId && item.category === row.category) ||
    !['direct', 'sdk'].includes(row.arm)
  ) {
    throw new Error(`Unexpected result: ${key}`);
  }
}

console.log(`Pilot: ${manifest.date}; ${tasks.length} tasks/model; one sample per arm`);
console.log('Correct is gold-scored. Accepted has a different contract in each arm.');
for (const model of manifest.models) {
  console.log(`\n${model.name} (${model.digest?.slice(0, 12) || 'unknown digest'})`);
  for (const category of ['extract', 'decide', 'tool', 'long-context']) {
    for (const arm of ['direct', 'sdk']) {
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
        `${category.padEnd(12)} ${arm.padEnd(6)} correct ${count('correct')}/${group.length}; silently wrong ${count('silentWrong')}; accepted ${count('accepted')}; calls ${sum('calls')}; reported tokens ${sum('promptTokens') + sum('completionTokens')}; other statuses ${statuses}`
      );
    }
  }
}
console.log(
  '\nExploratory sample only. Read raw rows and task definitions before interpreting differences.'
);
