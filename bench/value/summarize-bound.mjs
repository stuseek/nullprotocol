#!/usr/bin/env node
// Per variant: accepted compactions, how many of the chunk's expected facts
// are bound to the right object, current-order and correction outcomes, and
// false claims about the customer. With --review, also how often the bound
// verdicts agree with a manual review.
//
//   node bench/value/summarize-bound.mjs BOUND.jsonl [--review REVIEW.jsonl]
import { readFileSync } from 'node:fs';

const lines = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const reviewAt = process.argv.indexOf('--review');
const [, ...rows] = lines(process.argv[2]);
const falseClaim = bound => bound.boughtProducts + bound.orderContents > 0;

const variants = [...new Set(rows.map(row => row.variant))];
console.log(
  'variant\tvalid\tbound/expected\torder current/cancelled_as_current/ambiguous/wrong\tcorrection recorded/due\tfalse claims\tunreadable\tcalls\tmedian ms'
);
for (const variant of variants) {
  const group = rows.filter(row => row.variant === variant);
  const read = group.filter(row => row.bound);
  let expected = 0;
  let bound = 0;
  for (const row of group) {
    expected += row.expected.length;
    if (!row.bound) continue;
    const verdicts = {
      name: row.bound.name === 'correct',
      order: row.bound.order === 'current',
      allergy: row.bound.allergy === 'correct',
      city: row.bound.city === 'correct'
    };
    bound += row.expected.filter(fact => verdicts[fact]).length;
  }
  const orders = ['current', 'cancelled_as_current', 'ambiguous', 'wrong'].map(
    value => read.filter(row => row.bound.order === value).length
  );
  const due = group.filter(row => row.truth?.cancelledOrder || row.expected.includes('order'));
  const ms = group.map(row => row.ms).sort((a, b) => a - b);
  console.log(
    [
      variant,
      `${group.filter(row => row.valid).length}/${group.length}`,
      `${bound}/${expected}`,
      orders.join('/'),
      `${read.filter(row => row.bound.correction === 'recorded').length}/${due.length}`,
      read.filter(row => falseClaim(row.bound)).length,
      group.filter(row => row.facts.length && !row.bound).length,
      group.reduce((total, row) => total + row.calls, 0),
      ms[Math.floor(ms.length / 2)]
    ].join('\t')
  );
}

if (reviewAt !== -1) {
  const key = row => `${row.pick} ${row.variant} ${row.rep}`;
  const byKey = new Map(rows.map(row => [key(row), row]));
  const agree = { order: 0, correction: 0, falseClaim: 0 };
  const disagreements = [];
  const reviews = lines(process.argv[reviewAt + 1]);
  for (const review of reviews) {
    const bound = byKey.get(key(review))?.bound;
    if (!bound) {
      disagreements.push(`${key(review)}: not read`);
      continue;
    }
    const auto = {
      order: bound.order,
      correction: bound.correction,
      falseClaim: falseClaim(bound)
    };
    for (const field of Object.keys(agree)) {
      if (auto[field] === review[field]) agree[field]++;
      else
        disagreements.push(`${key(review)} ${field}: auto ${auto[field]} manual ${review[field]}`);
    }
  }
  console.log(
    `\nagreement with manual review (${reviews.length} rows): ${Object.entries(agree)
      .map(([field, count]) => `${field} ${count}/${reviews.length}`)
      .join(', ')}`
  );
  for (const line of disagreements) console.log(`  ${line}`);
}
