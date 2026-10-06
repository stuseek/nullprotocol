// A refund decision: the model reads the customer's message, the code applies the shop's policy.
// Run: node examples/flows/refund.mjs
import { ai } from './model.mjs';

// The order comes from your order system, not from the model.
const order = { category: 'kitchen', price: 120, delivered: '2026-09-12' };
const today = '2026-10-06';
const message =
  'Order 6642: the blender came on 12 September. I used it twice and do not like it. Refund please.';

// The policy lives in code: 30 days to return (14 for electronics), 15% fee on a used item,
// and anything above $200 goes to a person.
function decide({ category, price, delivered }, used) {
  const days = (Date.parse(today) - Date.parse(delivered)) / 86400000;
  if (days > (category === 'electronics' ? 14 : 30)) return { action: 'deny', amount: 0 };
  const amount = Math.round(price * (used ? 85 : 100)) / 100;
  return amount > 200 ? { action: 'escalate', amount: 0 } : { action: 'refund', amount };
}

const read = await ai.extract(message, {
  type: 'object',
  required: ['evidence', 'condition'],
  properties: {
    evidence: {
      type: 'string',
      description: "The customer's exact words about the state of the item"
    },
    condition: {
      type: 'string',
      enum: ['untouched', 'used'],
      description:
        'untouched: still sealed, wrapped, never unpacked, or tags still on. used: opened, assembled, set up, built or tried.'
    }
  }
});
if (!read.success) throw new Error(read.error); // hand the ticket to a person

console.log(read.data);
console.log(decide(order, read.data.condition === 'used')); // { action: 'refund', amount: 102 }
console.log(read.usage);
