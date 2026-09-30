// Per-fact scoring of a memory probe answer (version 2). Each fact is judged
// only in the clauses about its own field, so "I don't know your city" does
// not cancel a correct name. true: the expected value is stated for the right
// field and not contradicted; false: the field is denied, missing, or given a
// wrong value; null: ambiguous, for manual review.

const VERSION = 'memory-score-2';

const fields = {
  name: /\bname\b|\bi'?m\b|\bcalled\b/i,
  order: /\border\b/i,
  allergy: /\ballerg/i,
  city: /\bcity\b|\bwriting from\b|\bfrom\b|\blocated\b|\blive\b/i
};
const denial =
  /\b(not (specified|provided|mentioned|include[ds]?|given|available)|no (information|details|record)|don'?t (have|know)|do not (have|know)|did(n'?t| not) (include|mention|provide|say)|unable to|cannot|can'?t|without access|no access)\b/i;
const correctionMarker =
  /\b(cancel(l)?ed|previous|old|earlier|former|replaced|instead|no longer)\b/i;
const itemWords =
  /\b(lamp|table|vase|rug|throw|cushion|shelf|towel|item|product|sku|compared|comparing)\b/i;

// Clauses: lines, sentences, semicolons, and comma-joined "your X is ..." parts.
function clauses(answer) {
  return answer
    .split(/\n+|(?<=[.!?])\s+|;\s*|,\s*(?=(?:and\s+)?(?:your|you|i|my|the)\b)/i)
    .map(part => part.trim())
    .filter(Boolean);
}

const includes = (text, value) => text.toLowerCase().includes(value.toLowerCase());

function combine(votes) {
  const yes = votes.includes(true);
  const no = votes.includes(false);
  if (yes && !no) return true;
  if (no && !yes) return false;
  return votes.length ? null : undefined;
}

function scoreField(parts, field, values, answer) {
  const relevant = parts.filter(part => fields[field].test(part));
  const votes = relevant.map(part => {
    const stated = values.some(value => includes(part, value));
    if (stated) return denial.test(part) ? null : true;
    return denial.test(part) ? false : undefined;
  });
  const decided = combine(votes.filter(vote => vote !== undefined));
  if (decided !== undefined) return decided;
  // Not stated in a clause about this field: stated elsewhere is ambiguous.
  return values.some(value => includes(answer, value)) ? null : false;
}

// The order: the new number is correct; the cancelled one is correct only as
// history ("58213 was cancelled, 58977 is current"); a number tied to an item
// rather than the customer's order does not count.
function scoreOrder(parts, customer, answer) {
  const votes = [];
  for (const part of parts) {
    const newer = includes(part, customer.newOrder);
    const older = includes(part, customer.order);
    if (!newer && !older) {
      if (fields.order.test(part) && denial.test(part)) votes.push(false);
      continue;
    }
    if (itemWords.test(part) && !/\b(your|current|new) order\b/i.test(part)) {
      votes.push(false);
      continue;
    }
    if (newer && older) {
      votes.push(correctionMarker.test(part) ? true : null);
    } else if (newer) {
      votes.push(denial.test(part) ? null : true);
    } else {
      // Only the cancelled number: fine as history, wrong as current.
      if (!correctionMarker.test(part)) votes.push(false);
    }
  }
  const decided = combine(votes);
  if (decided !== undefined) return decided;
  return includes(answer, customer.newOrder) ? null : false;
}

function scoreProbe(customer, answer) {
  if (!answer) return { name: false, order: false, allergy: false, city: false };
  const parts = clauses(answer);
  return {
    name: scoreField(parts, 'name', customer.name.split(' '), answer),
    order: scoreOrder(parts, customer, answer),
    allergy: scoreField(parts, 'allergy', [customer.allergy], answer),
    city: scoreField(parts, 'city', [customer.city], answer)
  };
}

module.exports = { VERSION, scoreProbe };
