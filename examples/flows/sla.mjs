// A resolution deadline: the model reads when the ticket was opened and its priority,
// the code counts business hours.
// Run: node examples/flows/sla.mjs
import { ai } from './model.mjs';

const ticket =
  'Ticket #5120 opened Friday 2 October 2026 at 16:40. Priority: P2. Customer cannot export reports.';
const HOURS = { P1: 2, P2: 8, P3: 24 }; // business hours to resolve; Monday to Friday, 09:00 to 18:00

function deadline(createdAt, priority) {
  let t = new Date(`${createdAt}:00Z`);
  let left = HOURS[priority] * 60;
  while (left > 0) {
    const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
    const weekday = t.getUTCDay() >= 1 && t.getUTCDay() <= 5;
    if (!weekday || minutes >= 1080)
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 9));
    else if (minutes < 540) t.setUTCHours(9, 0);
    else {
      const use = Math.min(left, 1080 - minutes);
      t = new Date(t.getTime() + use * 60000);
      left -= use;
    }
  }
  return t.toISOString().slice(0, 16);
}

const read = await ai.extract(ticket, {
  type: 'object',
  required: ['createdAt', 'priority'],
  properties: {
    createdAt: {
      type: 'string',
      description: 'When the ticket was opened, as YYYY-MM-DDTHH:MM',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$'
    },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] }
  }
});
if (!read.success) throw new Error(read.error);

console.log(read.data);
console.log(deadline(read.data.createdAt, read.data.priority)); // 2026-10-05T15:40
