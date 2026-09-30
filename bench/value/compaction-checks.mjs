// Checks for a compaction reply, shared by the classifier and the offline
// ablation. `reason` mirrors parseCompaction's checks in order and names the
// first that fails. The fact checks below use deterministic ground truth of
// the pilot's memory case (ids, names, places); they are benchmark scoring,
// not something the SDK does.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJSON } = require('../../src/json');

export function reason(content, sources) {
  let parsed;
  try {
    parsed = parseJSON(content);
  } catch {
    return { reason: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { reason: 'schema:not_object' };
  if (!Array.isArray(parsed.facts)) return { reason: 'schema:facts_missing' };
  if (typeof parsed.summary !== 'string') return { reason: 'schema:summary_missing', parsed };
  if (parsed.facts.length > 5) return { reason: 'schema:more_than_5_facts', parsed };
  for (const fact of parsed.facts) {
    if (
      !fact ||
      typeof fact.value !== 'object' ||
      fact.value === null ||
      Array.isArray(fact.value)
    ) {
      return { reason: 'schema:value_not_object', parsed };
    }
    if (!Array.isArray(fact.sourceSeqs) || !fact.sourceSeqs.length)
      return { reason: 'schema:no_sources', parsed };
    if (!fact.sourceSeqs.every(Number.isInteger))
      return { reason: 'schema:sources_not_integers', parsed };
    if (new Set(fact.sourceSeqs).size !== fact.sourceSeqs.length)
      return { reason: 'schema:duplicate_sources', parsed };
  }
  if (!parsed.summary.trim()) return { reason: 'summary_empty', parsed };
  if (Buffer.byteLength(parsed.summary.trim()) > 4000)
    return { reason: 'summary_too_large', parsed };
  const cited = new Set(sources.map(message => message.seq));
  if (parsed.facts.some(fact => !fact.sourceSeqs.every(seq => cited.has(seq)))) {
    return { reason: 'citation_outside_chunk', parsed };
  }
  if (parsed.facts.some(fact => Buffer.byteLength(JSON.stringify(fact.value)) > 2048)) {
    return { reason: 'fact_too_large', parsed };
  }
  return { reason: 'valid', parsed };
}

// The problem in words a model can act on, for a repair turn.
export function problemText(result, sources) {
  const first = sources[0]?.seq;
  const last = sources.at(-1)?.seq;
  return (
    {
      parse: 'The reply was not valid JSON.',
      'schema:not_object': 'The reply must be one JSON object with facts and summary.',
      'schema:facts_missing': 'facts must be an array.',
      'schema:summary_missing': 'summary must be a string.',
      'schema:more_than_5_facts': `There are ${result.parsed?.facts?.length} facts; the maximum is 5.`,
      'schema:value_not_object': 'Each fact value must be a JSON object.',
      'schema:no_sources': 'Each fact needs sourceSeqs.',
      'schema:sources_not_integers': 'sourceSeqs must be integers.',
      'schema:duplicate_sources': 'sourceSeqs must not repeat.',
      summary_empty: 'summary must not be empty.',
      summary_too_large: 'summary must be under 4000 bytes.',
      citation_outside_chunk: `sourceSeqs must be sequence numbers from these records, ${first} to ${last}.`,
      fact_too_large: 'Each fact value must be under 2048 bytes.'
    }[result.reason] || 'The reply does not match the required format.'
  );
}

// Which of the memory case's facts the sources contain, and which the facts
// state. The current order is the new number; the cancelled one is current
// only if the change is not in these sources.
export function expectedFacts(sources, customer) {
  const text = JSON.stringify(sources).toLowerCase();
  const expected = [];
  if (text.includes(customer.name.split(' ')[1].toLowerCase())) expected.push('name');
  if (text.includes(customer.newOrder)) expected.push('order');
  if (text.includes(customer.allergy)) expected.push('allergy');
  if (text.includes(customer.city.toLowerCase())) expected.push('city');
  return expected;
}

export function statedFacts(facts, customer) {
  const values = facts.map(fact => JSON.stringify(fact.value).toLowerCase());
  const any = test => values.some(test);
  const stated = [];
  if (
    any(
      v =>
        v.includes(customer.name.split(' ')[1].toLowerCase()) ||
        v.includes(customer.name.split(' ')[0].toLowerCase())
    )
  )
    stated.push('name');
  if (any(v => v.includes(customer.newOrder) && !v.includes('cancel'))) stated.push('order');
  if (any(v => v.includes(customer.allergy.replace(/s$/, '')))) stated.push('allergy');
  if (any(v => v.includes(customer.city.toLowerCase()))) stated.push('city');
  // A valid but wrong fact: the new order called cancelled, or the cancelled
  // order stated without saying so.
  const wrong = values.filter(
    v =>
      (v.includes(customer.newOrder) && v.includes('cancel') && !v.includes(customer.order)) ||
      (v.includes(customer.order) && !v.includes('cancel') && !v.includes(customer.newOrder))
  ).length;
  return { stated, wrong };
}
