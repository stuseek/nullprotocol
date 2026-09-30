#!/usr/bin/env node
// Why captured compaction replies were rejected. Mirrors parseCompaction's
// checks in order but names the first one that fails, so invalid_compaction
// can be split into parse, schema, citation, summary and size problems.
//
//   node bench/value/classify-compaction.mjs CAPTURE.jsonl
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJSON } = require('../../src/json');

function reason(record) {
  if (record.status !== 200) return `http_${record.status}`;
  const content = JSON.parse(record.text).choices?.[0]?.message?.content ?? '';
  const sources = JSON.parse(record.request.messages[1].content).sources;
  let parsed;
  try {
    parsed = parseJSON(content);
  } catch {
    return 'parse';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'schema:not_object';
  if (!Array.isArray(parsed.facts)) return 'schema:facts_missing';
  if (typeof parsed.summary !== 'string') return 'schema:summary_missing';
  if (parsed.facts.length > 5) return 'schema:more_than_5_facts';
  for (const fact of parsed.facts) {
    if (
      !fact ||
      typeof fact.value !== 'object' ||
      fact.value === null ||
      Array.isArray(fact.value)
    ) {
      return 'schema:value_not_object';
    }
    if (!Array.isArray(fact.sourceSeqs) || !fact.sourceSeqs.length) return 'schema:no_sources';
    if (!fact.sourceSeqs.every(Number.isInteger)) return 'schema:sources_not_integers';
    if (new Set(fact.sourceSeqs).size !== fact.sourceSeqs.length) return 'schema:duplicate_sources';
    if ('actionOutcome' in fact.value) return 'schema:action_outcome';
  }
  if (!parsed.summary.trim()) return 'summary_empty';
  if (Buffer.byteLength(parsed.summary.trim()) > 4000) return 'summary_too_large';
  const cited = new Set(sources.map(message => message.seq));
  if (parsed.facts.some(fact => !fact.sourceSeqs.every(seq => cited.has(seq)))) {
    return 'citation_outside_chunk';
  }
  if (parsed.facts.some(fact => Buffer.byteLength(JSON.stringify(fact.value)) > 2048)) {
    return 'fact_too_large';
  }
  return 'valid';
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
