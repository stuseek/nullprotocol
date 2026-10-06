// 48 workflow tasks, 12 per family: invoice totals, refunds under a shop policy, SLA deadlines in business hours,
// and filtering a ticket queue. Gold answers are computed by code, never typed by hand.
const r2 = n => Math.round(n * 100) / 100;
// Deterministic pseudo-random numbers, so the generated tasks are the same on every run.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// A. Invoice totals
const invoices = [
  {
    id: 'inv-1',
    discount: 10,
    tax: 8.5,
    items: [
      ['USB-C cable 2m', 12, 7.49],
      ['Laptop stand', 3, 34.9],
      ['Wireless mouse', 5, 18.25],
      ['HDMI adapter', 8, 11.6],
      ['Desk mat', 4, 22.0],
      ['Webcam cover', 25, 1.35]
    ]
  },
  {
    id: 'inv-2',
    discount: 0,
    tax: 20,
    items: [
      ['Annual license', 7, 129.0],
      ['Onboarding session', 2, 450.0],
      ['Extra seat', 13, 19.99],
      ['Priority support', 1, 899.5]
    ]
  },
  {
    id: 'inv-3',
    discount: 12.5,
    tax: 7.25,
    items: [
      ['Paper A4 box', 14, 23.8],
      ['Toner black', 6, 61.45],
      ['Stapler', 9, 8.15],
      ['Binder clips 100', 11, 4.2],
      ['Whiteboard marker set', 7, 9.99],
      ['Label roll', 16, 3.75],
      ['Envelope C5 500', 3, 27.3]
    ]
  }
];
const PRODUCTS = [
  ['Ethernet cable 5m', 6.4],
  ['Monitor arm', 79.0],
  ['Mechanical keyboard', 64.5],
  ['Notebook A5', 3.95],
  ['Ballpoint pens 50', 12.3],
  ['Desk lamp', 27.8],
  ['Power strip', 15.25],
  ['Whiteboard 90x60', 48.6],
  ['Sticky notes 12', 5.15],
  ['Laptop sleeve', 21.4],
  ['USB hub 7-port', 32.75],
  ['Headset', 44.9],
  ['Printer paper 5 reams', 28.35],
  ['Cable ties 200', 4.6],
  ['Screen cleaner', 7.05],
  ['Footrest', 36.2],
  ['Filing box', 9.8],
  ['Extension lead 10m', 18.95],
  ['Chair mat', 52.4],
  ['Coffee beans 1kg', 16.7]
];
for (let n = 4; n <= 12; n++) {
  const rand = rng(3000 + n);
  const pool = [...PRODUCTS];
  const items = [];
  for (let k = 0, count = 4 + Math.floor(rand() * 5); k < count; k++) {
    const [name, price] = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    items.push([name, 1 + Math.floor(rand() * 25), price]);
  }
  invoices.push({
    id: `inv-${n}`,
    discount: pick(rand, [0, 5, 10, 12.5, 15]),
    tax: pick(rand, [0, 7.25, 8.5, 19, 20]),
    items
  });
}
const invoiceText = v =>
  `INVOICE ${v.id.toUpperCase()}\n` +
  v.items.map(([n, q, p]) => `${n} — qty ${q} at $${p.toFixed(2)} each`).join('\n') +
  `\n${v.discount ? `Volume discount: ${v.discount}% off the subtotal\n` : ''}Sales tax: ${v.tax}% applied after the discount`;
const invoiceGold = v => {
  const subtotal = r2(v.items.reduce((s, [, q, p]) => s + q * p, 0));
  const total = r2(subtotal * (1 - v.discount / 100) * (1 + v.tax / 100));
  return { subtotal, total };
};

// B. Refund policy
const POLICY = `Refund policy:
1. A refund is allowed within 30 days of delivery. For electronics the window is 14 days.
2. An opened item is refunded minus a 15% restocking fee. An unopened item is refunded in full.
3. A refund above $200.00 (after any fee) is never issued automatically: escalate it to a human.
4. Outside the window the request is denied.`;
const refunds = [
  {
    id: 'ref-1',
    today: '2026-10-06',
    delivered: '2026-09-21',
    category: 'clothing',
    opened: false,
    price: 89.0,
    text: 'Hi, the jacket from order 7712 does not fit, I have not even taken the tags off. It arrived on September 21. I paid $89.00. Can I get my money back?'
  },
  {
    id: 'ref-2',
    today: '2026-10-06',
    delivered: '2026-09-16',
    category: 'electronics',
    opened: false,
    price: 149.0,
    text: 'Order 8120, the bluetooth speaker ($149.00) was delivered on 16 September. The box is still sealed. I changed my mind, please refund.'
  },
  {
    id: 'ref-3',
    today: '2026-10-06',
    delivered: '2026-09-25',
    category: 'furniture',
    opened: true,
    price: 240.0,
    text: 'I assembled the office chair from order 9001 (delivered Sept 25, cost $240.00) and it squeaks. I want a refund.'
  },
  {
    id: 'ref-4',
    today: '2026-10-06',
    delivered: '2026-09-12',
    category: 'kitchen',
    opened: true,
    price: 120.0,
    text: 'Order 6642: the blender, $120.00, came on 2026-09-12. I used it twice and do not like it. Refund please.'
  },
  {
    id: 'ref-5',
    today: '2026-10-06',
    delivered: '2026-09-24',
    category: 'electronics',
    opened: true,
    price: 59.9,
    text: 'The headphones from order 7003 ($59.90) arrived 24 Sep. I opened them and tried them, the sound is bad. Refund?'
  },
  {
    id: 'ref-6',
    today: '2026-10-06',
    delivered: '2026-09-10',
    category: 'books',
    opened: false,
    price: 42.5,
    text: 'Order 5521, the cookbook. Still in its shrink wrap, it was a duplicate gift. Please refund the $42.50.'
  },
  {
    id: 'ref-7',
    today: '2026-10-06',
    delivered: '2026-09-29',
    category: 'electronics',
    opened: true,
    price: 310.0,
    text: 'The tablet from order 5630 has been set up and I used it for a week, but the screen flickers. I want my $310 back.'
  },
  {
    id: 'ref-8',
    today: '2026-10-06',
    delivered: '2026-08-30',
    category: 'garden',
    opened: false,
    price: 75.0,
    text: 'I never unpacked the hose reel (order 5702). Can I return it for a refund?'
  },
  {
    id: 'ref-9',
    today: '2026-10-06',
    delivered: '2026-09-27',
    category: 'toys',
    opened: true,
    price: 64.0,
    text: 'Order 5718: my son built the model kit already and two parts were missing. Refund please.'
  },
  {
    id: 'ref-10',
    today: '2026-10-06',
    delivered: '2026-09-23',
    category: 'electronics',
    opened: false,
    price: 199.0,
    text: 'Smart watch, order 5733, factory seal intact. I got another one for my birthday. Requesting a refund.'
  },
  {
    id: 'ref-11',
    today: '2026-10-06',
    delivered: '2026-09-18',
    category: 'furniture',
    opened: true,
    price: 236.0,
    text: 'We put the bookshelf from order 5790 together and it wobbles. Please refund us.'
  },
  {
    id: 'ref-12',
    today: '2026-10-06',
    delivered: '2026-09-08',
    category: 'sports',
    opened: false,
    price: 130.0,
    text: 'Order 5811, the yoga mat set. It is still in the original packaging, I ordered the wrong size. Could you refund it?'
  }
];
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const refundRule = ({ today, delivered, category, opened, price }) => {
  if (days(delivered, today) > (category === 'electronics' ? 14 : 30))
    return { action: 'deny', amount: 0 };
  const amount = r2(opened ? price * 0.85 : price);
  return amount > 200 ? { action: 'escalate', amount: 0 } : { action: 'refund', amount };
};

// C. SLA deadline in business hours (Mon–Fri 09:00–18:00)
const SLA = { P1: 2, P2: 8, P3: 24 };
const slaExtra = [
  ['2026-10-03T10:20', 'P1', 'login page returns an error'],
  ['2026-10-06T08:10', 'P2', 'invoices are sent twice'],
  ['2026-10-08T17:59', 'P1', 'payments fail for one bank'],
  ['2026-10-09T15:00', 'P3', 'wrong logo in the email footer'],
  ['2026-10-05T09:00', 'P2', 'search is slow'],
  ['2026-10-09T17:30', 'P2', 'CSV import skips rows'],
  ['2026-10-04T13:45', 'P3', 'dark mode contrast'],
  ['2026-10-07T12:00', 'P1', 'API returns 500 on refunds'],
  ['2026-10-01T14:20', 'P3', 'timezone shown wrong in reports']
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];
const slaText = (n, created, priority, issue) => {
  const d = new Date(created + ':00Z'),
    time = created.slice(11),
    day = WEEKDAYS[d.getUTCDay()];
  return [
    `Ticket #${5200 + n} opened ${day} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} 2026 at ${time}. Priority: ${priority}. Issue: ${issue}.`,
    `Ticket #${5200 + n}, created on ${day} ${created.slice(0, 10)} ${time}, priority ${priority}: ${issue}.`,
    `#${5200 + n} (${priority}) was opened at ${time} on ${day}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, 2026. ${issue[0].toUpperCase()}${issue.slice(1)}.`
  ][n % 3];
};
const slas = [
  {
    id: 'sla-1',
    created: '2026-10-02T16:40',
    priority: 'P2',
    text: 'Ticket #5120 opened Friday 2 October 2026 at 16:40. Priority: P2. Customer cannot export reports.'
  },
  {
    id: 'sla-2',
    created: '2026-10-05T17:15',
    priority: 'P1',
    text: 'Ticket #5133 opened on Monday 2026-10-05 17:15, priority P1, checkout is down for one merchant.'
  },
  {
    id: 'sla-3',
    created: '2026-10-07T11:30',
    priority: 'P3',
    text: 'Ticket #5140, created Wednesday 7 Oct 2026 11:30. P3: typo on the billing page.'
  },
  ...slaExtra.map(([created, priority, issue], n) => ({
    id: `sla-${n + 4}`,
    created,
    priority,
    text: slaText(n, created, priority, issue)
  }))
];
const slaDeadline = (created, priority) => {
  let t = new Date(created + ':00Z');
  let left = SLA[priority] * 60;
  const open = d => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  while (left > 0) {
    const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
    if (!open(t) || mins >= 1080) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 9));
      continue;
    }
    if (mins < 540) {
      t.setUTCHours(9, 0);
      continue;
    }
    const use = Math.min(left, 1080 - mins);
    t = new Date(t.getTime() + use * 60000);
    left -= use;
  }
  return t.toISOString().slice(0, 16);
};
const SLA_TEXT =
  'SLA: P1 must be resolved within 2 business hours, P2 within 8 business hours, P3 within 24 business hours. Business hours are Monday to Friday, 09:00 to 18:00. The clock stops outside business hours.';

// D. Ticket queue aggregation
const queue = {
  today: '2026-10-06',
  rows: [
    ['T-301', 'open', '2026-10-05', 'Acme'],
    ['T-302', 'closed', '2026-09-28', 'Birch'],
    ['T-303', 'open', '2026-09-30', 'Cobalt'],
    ['T-304', 'pending', '2026-10-01', 'Acme'],
    ['T-305', 'open', '2026-10-02', 'Dune'],
    ['T-306', 'open', '2026-10-03', 'Elm'],
    ['T-307', 'closed', '2026-10-04', 'Cobalt'],
    ['T-308', 'open', '2026-09-22', 'Fjord'],
    ['T-309', 'pending', '2026-09-29', 'Birch'],
    ['T-310', 'open', '2026-10-06', 'Gale'],
    ['T-311', 'open', '2026-10-01', 'Acme'],
    ['T-312', 'closed', '2026-09-30', 'Dune'],
    ['T-313', 'open', '2026-10-04', 'Hale'],
    ['T-314', 'open', '2026-09-27', 'Elm'],
    ['T-315', 'pending', '2026-10-05', 'Fjord'],
    ['T-316', 'open', '2026-10-02', 'Birch'],
    ['T-317', 'closed', '2026-10-01', 'Gale'],
    ['T-318', 'open', '2026-09-25', 'Cobalt']
  ]
};
const CUSTOMERS = [
  'Acme',
  'Birch',
  'Cobalt',
  'Dune',
  'Elm',
  'Fjord',
  'Gale',
  'Hale',
  'Iris',
  'Juno'
];
const makeQueue = (seed, today, first) => {
  const rand = rng(seed),
    rows = [];
  for (let k = 0, count = 18 + Math.floor(rand() * 5); k < count; k++) {
    const created = new Date(Date.parse(today) - Math.floor(rand() * 15) * 86400000)
      .toISOString()
      .slice(0, 10);
    rows.push([
      `T-${first + k}`,
      pick(rand, ['open', 'open', 'open', 'pending', 'closed']),
      created,
      pick(rand, CUSTOMERS)
    ]);
  }
  return { today, rows };
};
const queues = [queue, makeQueue(77, '2026-10-12', 420), makeQueue(91, '2026-10-20', 610)];
const queueText = q =>
  `Ticket queue as of ${q.today}:\n` +
  q.rows.map(([id, st, d, c]) => `${id} | ${c} | status: ${st} | created ${d}`).join('\n');
const queueGold = (q, status, min) =>
  q.rows
    .filter(([, st, d]) => st === status && days(d, q.today) > min)
    .map(r => r[0])
    .sort();
const queueAsks = [
  ['open', 3],
  ['open', 5],
  ['pending', 2],
  ['open', 7]
];

export const tasks = [
  ...invoices.map(v => ({
    id: v.id,
    family: 'invoice',
    material: invoiceText(v),
    question:
      'Compute the subtotal (before discount and tax) and the final total. Round both to 2 decimals.',
    shape: '{"subtotal": number, "total": number}',
    gold: invoiceGold(v),
    check: (a, g) =>
      Math.abs(a.subtotal - g.subtotal) < 0.011 && Math.abs(a.total - g.total) < 0.011
  })),
  ...refunds.map(v => ({
    id: v.id,
    family: 'refund',
    material: `${POLICY}\n\nToday is ${v.today}.\n\nOrder record from the order system: category ${v.category}, price $${v.price.toFixed(2)}, delivered ${v.delivered}.\n\nCustomer message:\n${v.text}`,
    question:
      'Apply the policy. action is one of refund, deny, escalate. amount is the money to refund now (0 for deny or escalate).',
    shape: '{"action": string, "amount": number}',
    gold: refundRule(v),
    raw: v,
    check: (a, g) => a.action === g.action && Math.abs(Number(a.amount) - g.amount) < 0.011
  })),
  ...slas.map(v => ({
    id: v.id,
    family: 'sla',
    material: `${SLA_TEXT}\n\n${v.text}`,
    question: 'When is the resolution deadline? Answer as local time in the form YYYY-MM-DDTHH:MM.',
    shape: '{"deadline": string}',
    gold: { deadline: slaDeadline(v.created, v.priority) },
    raw: v,
    check: (a, g) => String(a.deadline).slice(0, 16) === g.deadline
  })),
  ...queues.flatMap((q, n) =>
    queueAsks.map(([status, min]) => ({
      id: `queue-${n + 1}-${status}-${min}`,
      family: 'queue',
      material: queueText(q),
      question: `Which tickets have status ${status} and were created more than ${min} days before today? List their ids sorted ascending and give the count.`,
      shape: '{"ids": string[], "count": number}',
      gold: { ids: queueGold(q, status, min), count: queueGold(q, status, min).length },
      raw: { status, min },
      check: (a, g) =>
        JSON.stringify([...(a.ids || [])].sort()) === JSON.stringify(g.ids) && a.count === g.count
    }))
  )
];
export { POLICY, SLA_TEXT, refundRule, slaDeadline, queue, days, r2 };
