#!/usr/bin/env node
// Why captured compaction replies were rejected. Mirrors parseCompaction's
// checks in order but names the first one that fails, so invalid_compaction
// can be split into parse, schema, citation, summary and size problems.
//
//   node bench/value/classify-compaction.mjs CAPTURE.jsonl
import { readFileSync } from 'node:fs';
import { reason as check } from './compaction-checks.mjs';

function reason(record) {
  if (record.status !== 200) return `http_${record.status}`;
  const content = JSON.parse(record.text).choices?.[0]?.message?.content ?? '';
  const sources = JSON.parse(record.request.messages[1].content).sources;
  return check(content, sources).reason;
}

const records = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const counts = new Map();
for (const record of records) {
  const key = `${record.model}\t${reason(record)}`;
  const entry = counts.get(key) || { count: 0, ms: [] };
  entry.count++;
  entry.ms.push(record.ms);
  counts.set(key, entry);
}
console.log('model\treason\tcount\tmedianMs\tmaxMs');
for (const [key, { count, ms }] of counts) {
  const sorted = ms.sort((a, b) => a - b);
  console.log(`${key}\t${count}\t${sorted[Math.floor(sorted.length / 2)]}\t${sorted.at(-1)}`);
}
