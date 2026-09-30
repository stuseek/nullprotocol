#!/usr/bin/env node
// Paired tables for a value pilot file (short cases or memory):
//   node bench/value/summarize.mjs bench/results/value-short-2.jsonl
import { readFileSync } from 'node:fs';

const [header, ...rows] = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const { manifest } = header;
console.log(
  `${manifest.kind} ${(manifest.source?.commit ?? manifest.sdkCommit).slice(0, 7)} reps ${manifest.reps}`
);

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const groupBy = (items, key) => {
  const groups = new Map();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) || []), item]);
  return groups;
};
// Failure kinds with counts, e.g. "infrastructure:space_busy x1".
const failures = group => {
  const counts = new Map();
  for (const row of group.filter(item => item.errorCode)) {
    const label = `${row.failureClass ?? '?'}:${row.errorCode}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} x${count}`).join(',') || '-';
};
const print = table => console.log(table.map(line => line.join('\t')).join('\n'));

function shortTables() {
  const ms = row => row.ms ?? (row.modelCalls || []).reduce((total, call) => total + call.ms, 0);
  const table = [
    [
      'model',
      'case',
      'arm',
      'effects',
      'content t/f/review',
      'answered',
      'extraRefunds',
      'proposed',
      'guardNo',
      'handlerNo',
      'commitments',
      'denied',
      'failures',
      'medianMs'
    ]
  ];
  for (const [key, group] of groupBy(rows, row => `${row.model}\t${row.case}\t${row.arm}`)) {
    const count = predicate => group.filter(predicate).length;
    const allowed = row => (row.case === 'A1' ? 1 : 0);
    const extra = group.reduce(
      (total, row) => total + Math.max(0, row.executions.length - allowed(row)),
      0
    );
    table.push([
      key,
      `${count(row => row.effectsCorrect)}/${group.length}`,
      `${count(row => row.contentCorrect === true)}/${count(row => row.contentCorrect === false)}/${count(row => row.contentCorrect === null)}`,
      `${count(row => row.answered)}/${group.length}`,
      extra,
      ...['refundProposals', 'guardRefusals', 'handlerRefusals'].map(field =>
        group.reduce((total, row) => total + (row.counters?.[field] ?? 0), 0)
      ),
      group.filter(row => row.unsupportedCommitment === true).length,
      group.reduce((total, row) => total + (row.deniedCalls ?? 0), 0),
      failures(group),
      median(group.map(ms))
    ]);
  }
  print(table);
}

function memoryTables() {
  const table = [
    [
      'model',
      'fillers',
      'arm',
      'name',
      'order',
      'orderReview',
      'allergy',
      'city',
      'isolated',
      'clippedCalls',
      'summaryCalls',
      'compactions',
      'errors',
      'medianMs'
    ]
  ];
  for (const [key, group] of groupBy(rows, row => `${row.model}\t${row.fillers}\t${row.arm}`)) {
    const facts = fact => `${group.filter(row => row.facts[fact] === true).length}/${group.length}`;
    const calls = row => row.modelCalls || [];
    const steps = row => row.turns.flatMap(turn => turn.steps || []);
    table.push([
      key,
      facts('name'),
      facts('order'),
      group.filter(row => row.facts.order === null).length,
      facts('allergy'),
      facts('city'),
      `${group.filter(row => row.isolated === true).length}/${group.length}`,
      group.reduce((total, row) => total + calls(row).filter(call => call.clipped).length, 0),
      group.reduce(
        (total, row) => total + calls(row).filter(call => call.purpose === 'summary').length,
        0
      ),
      group.reduce(
        (total, row) => total + steps(row).filter(step => step.kind === 'compaction').length,
        0
      ),
      [
        ...new Set(
          group
            .flatMap(row => [row.errorCode, ...row.turns.map(turn => turn.errorCode)])
            .filter(Boolean)
        )
      ].join(',') || '-',
      median(group.map(row => row.ms))
    ]);
  }
  print(table);
}

// Where managed turns spent their time, median per model.
function latencyTable() {
  const turns = rows.flatMap(row =>
    row.latency
      ? [row]
      : (row.turns || []).filter(turn => turn.latency).map(turn => ({ ...turn, model: row.model }))
  );
  if (!turns.length) return;
  const fields = [
    'createMs',
    'queueMs',
    'modelMs',
    'actionMs',
    'compactionMs',
    'platformMs',
    'clientWaitMs',
    'apiCallMs'
  ];
  console.log('\nmanaged latency (median ms)');
  const table = [['model', 'turns', ...fields]];
  for (const [model, group] of groupBy(turns, turn => turn.model)) {
    table.push([
      model,
      group.length,
      ...fields.map(field => median(group.map(turn => turn.latency[field])))
    ]);
  }
  print(table);
}

if (manifest.kind.startsWith('value-pilot-memory')) memoryTables();
else shortTables();
latencyTable();
