#!/usr/bin/env node
// Scores whether accepted compaction facts bind the memory case's values to
// the right object: the name, city and allergy to the customer, the current
// order as current, the cancelled one as cancelled, and nothing the customer
// never said (no product bought, no order holding a product). Substring
// presence cannot tell "58977 cancelled" from "58977 placed", so a stronger
// model reads what the facts claim about the customer, without seeing the
// truth; code then compares those claims with the truth. A claimed value that
// is not in the facts' own text is not counted. The ablation file is only
// read; verdicts go to a separate file with the reader, schema and input hash.
//
//   MISTRAL_API_KEY=... node bench/value/judge-compaction.mjs ABLATION.jsonl CAPTURE.jsonl OUT.jsonl
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NullProtocol } = require('../../src');
const { memoryCase } = require('./memory');

const [ablation, capture, out] = process.argv.slice(2);
const readerModel = 'mistral-large-latest';
const customer = memoryCase(0, 30).customer;
const lines = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const sha = text => createHash('sha256').update(text).digest('hex');

const ai = new NullProtocol({
  engines: { openai: process.env.MISTRAL_API_KEY },
  defaultEngine: 'openai',
  openaiBaseURL: 'https://api.mistral.ai/v1',
  models: { openai: readerModel },
  temperature: 0,
  maxTokens: 600,
  timeout: 120_000,
  telemetry: false,
  configFile: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'no-config-file.json')
});

const text = description => ({ type: ['string', 'null'], description });
const list = description => ({ type: 'array', items: { type: 'string' }, description });
const schema = {
  type: 'object',
  properties: {
    customerName: text("The customer's name as these facts state it, or null."),
    customerCity: text('The city these facts say the customer is in or writes from, or null.'),
    customerAllergies: list('What these facts say the customer is allergic to.'),
    currentOrder: text(
      "The order number these facts present as the customer's current or active order: one stated as placed, new, active or current, or the only order number stated without any cancellation. Null when no order is stated or when the facts do not make clear which one is current."
    ),
    cancelledOrders: list('Order numbers these facts say were cancelled or replaced.'),
    unclearOrders: list(
      'Order numbers these facts mention without making clear whether they are current or cancelled.'
    ),
    boughtProducts: {
      type: 'array',
      description:
        'Products these facts say the customer bought or ordered. A product that is only described, compared, preferred or asked about is not bought.',
      items: {
        type: 'object',
        properties: {
          product: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'The exact words from the fact that say it was bought or ordered.'
          }
        },
        required: ['product', 'evidence']
      }
    },
    preferredProducts: list('Products these facts say the customer prefers or leans towards.'),
    orderContents: {
      type: 'array',
      description:
        'Products these facts say are in a numbered customer order. Use the order number, never a sourceSeqs or sequence number.',
      items: {
        type: 'object',
        properties: {
          order: { type: 'string' },
          product: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'The exact key or words from the fact that put the product in the order.'
          }
        },
        required: ['order', 'product', 'evidence']
      }
    }
  },
  required: [
    'customerName',
    'customerCity',
    'customerAllergies',
    'currentOrder',
    'cancelledOrders',
    'unclearOrders',
    'boughtProducts',
    'preferredProducts',
    'orderContents'
  ]
};
const instructions =
  'Read only what these compaction facts claim about the customer. Use nothing outside the facts, do not guess, and leave a field empty when the facts do not say it.';

// What was true once the sources (and the previous summary) had been seen.
function truth(record) {
  const { previousSummary, sources } = JSON.parse(record.request.messages[1].content);
  const corrected = JSON.stringify({ previousSummary, sources }).includes(customer.newOrder);
  return {
    currentOrder: corrected ? customer.newOrder : customer.order,
    cancelledOrder: corrected ? customer.order : null
  };
}

// The reader's claims compared with the truth. A claim whose value is not in
// the facts' text is ungrounded and counts as absent.
// Quotes are compared on words and numbers only: a reader quoting
// `orderDetails: {"product": ...}` still quotes the fact.
const words = value =>
  String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function score(claims, facts, known) {
  const source = words(JSON.stringify(facts));
  const ungrounded = [];
  const grounded = (field, value) => {
    if (value === null || value === undefined || value === '') return null;
    if (source.includes(words(value))) return words(value);
    ungrounded.push(`${field}:${value}`);
    return null;
  };
  const values = (field, items) => items.map(item => grounded(field, item)).filter(Boolean);
  const name = grounded('customerName', claims.customerName);
  const city = grounded('customerCity', claims.customerCity);
  const allergies = values('customerAllergies', claims.customerAllergies);
  const current = grounded('currentOrder', claims.currentOrder);
  const cancelled = values('cancelledOrders', claims.cancelledOrders);
  const unclear = values('unclearOrders', claims.unclearOrders);
  // A bought product or order content counts only when one fact holds the
  // product, the evidence and (for contents) the order number together.
  const factTexts = facts.map(fact => words(JSON.stringify(fact)));
  const together = (field, ...parts) => {
    const wanted = parts.map(words);
    if (factTexts.some(fact => wanted.every(part => fact.includes(part)))) return true;
    ungrounded.push(`${field}:${parts.join('|')}`);
    return false;
  };
  const bought = claims.boughtProducts.filter(
    item =>
      words(item.evidence) !== words(item.product) &&
      together('boughtProducts', item.product, item.evidence)
  );
  const preferred = values('preferredProducts', claims.preferredProducts);
  const contents = claims.orderContents.filter(item =>
    together('orderContents', item.order, item.product, item.evidence)
  );
  const nameParts = customer.name.toLowerCase().split(' ');
  const allergy = customer.allergy.replace(/s$/, '');
  let order = 'absent';
  if (current?.includes(known.currentOrder)) order = 'current';
  else if (known.cancelledOrder && current?.includes(known.cancelledOrder))
    order = 'cancelled_as_current';
  else if (current) order = 'wrong';
  else if (unclear.length || cancelled.length) order = 'ambiguous';
  let correction = 'not_due';
  if (known.cancelledOrder) {
    if (cancelled.some(value => value.includes(known.currentOrder))) correction = 'wrong';
    else if (cancelled.some(value => value.includes(known.cancelledOrder))) correction = 'recorded';
    else correction = 'absent';
  }
  const verdict = (value, right) => (!value ? 'absent' : right ? 'correct' : 'wrong');
  return {
    name: verdict(
      name,
      nameParts.some(part => name?.includes(part))
    ),
    city: verdict(city, city?.includes(customer.city.toLowerCase())),
    allergy: verdict(
      allergies.length,
      allergies.some(value => value.includes(allergy))
    ),
    order,
    correction,
    boughtProducts: bought.length,
    preferredProducts: preferred.length,
    orderContents: contents.length,
    ungrounded
  };
}

const [header, ...rows] = lines(ablation);
const records = lines(capture);
const judged = [];
for (const row of rows) {
  if (!row.facts.length) {
    judged.push({ ...row, claims: null, bound: null });
    continue;
  }
  const facts = row.facts.map(fact => fact.value);
  const known = truth(records[row.pick]);
  const result = await ai.extract({ instructions, facts }, schema);
  const bound = result.data ? score(result.data, facts, known) : null;
  judged.push({ ...row, truth: known, claims: result.data ?? { invalid: result.error }, bound });
  console.log(
    `#${row.pick} ${row.variant} r${row.rep}: ${
      bound
        ? `order ${bound.order} correction ${bound.correction} name ${bound.name} allergy ${bound.allergy} city ${bound.city} bought ${bound.boughtProducts} contents ${bound.orderContents} ungrounded ${bound.ungrounded.length}`
        : `invalid ${result.error}`
    }`
  );
  await new Promise(resolve => setTimeout(resolve, 1100));
}
writeFileSync(
  out,
  [
    {
      manifest: {
        kind: 'compaction-bound-v1',
        ablation: path.basename(ablation),
        ablationSha256: sha(readFileSync(ablation)),
        ablationManifest: header.manifest,
        readerModel,
        temperature: 0,
        instructions,
        schemaSha256: sha(JSON.stringify(schema)),
        scorerSha256: sha(readFileSync(fileURLToPath(import.meta.url)))
      }
    },
    ...judged
  ]
    .map(row => JSON.stringify(row))
    .join('\n') + '\n'
);
