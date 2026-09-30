// Hand-written compaction chunks for the domain-agnostic prompt pilot: two
// support and two DevOps conversations. Each has a correction, an open
// request or commitment, and bulk reference data. `expected` is frozen before
// any run and is only read by the manual review.

const catalogue = [
  'Ember table lamp: brass base, washed linen shade 30 cm, E27 bulb up to 40 W, 2 m fabric cable.',
  'Cove floor lamp: powder-coated steel, paper shade 45 cm, E27 bulb up to 60 W, foot switch.',
  'Halo pendant: smoked glass 25 cm, G9 bulb up to 25 W, 1.5 m adjustable drop.',
  'Replacement shades: linen 30 cm (Ember), paper 45 cm (Cove); glass diffusers are not sold separately.'
].join(' ');

const plans = [
  'Starter: €120 per month, 5 seats, 10k API calls.',
  'Team: €480 per month, 25 seats, 100k API calls, SSO.',
  'Scale: €1,400 per month, 100 seats, 1M API calls, SSO, audit log.',
  'Annual billing: two months free; plan changes take effect at the next billing date.'
].join(' ');

const deployLog = [
  '09:41:02 build checkout@v2.14.0 sha=7f3c9e1 ok',
  '09:41:40 push image registry/checkout:v2.14.0 ok',
  '09:42:05 staging: rollout started, 3 replicas',
  '09:42:31 staging: migration 0042_add_refund_index applied (requires replica lag < 5s during rollout)',
  '09:42:58 staging: replica lag 1.2s',
  '09:43:20 staging: readiness 3/3',
  '09:43:21 staging: smoke tests 48/48 passed',
  '09:43:22 staging: rollout complete'
].join('\n');

const metrics = [
  'payments-api 14:00 p99=310ms err=0.2% pods=3',
  'payments-api 14:05 p99=880ms err=0.9% pods=3',
  'payments-api 14:10 p99=1.9s err=2.4% pods=3',
  'payments-api 14:15 p99=2.4s err=3.1% pods=3',
  'db-proxy 14:15 connections=20/20 wait=640ms',
  'ledger-worker 14:15 queue=1,204 lag=48s'
].join('\n');

const runbook =
  'Runbook payments-api: 1. Check db-proxy saturation. 2. Scale within namespace quota. 3. Page the DBA before changing pool settings. 4. Post status every 30 minutes. 5. Open a postmortem within 24 hours.';

const turn = (seq, role, content) => ({ seq, role, content });

const chunks = [
  {
    id: 'S1',
    domain: 'support',
    sources: [
      turn(
        1,
        'user',
        "I'm Lena Ortiz, order 71402. The Ember table lamp arrived with a cracked shade."
      ),
      turn(2, 'assistant', 'Sorry about that. I can send a replacement shade or refund the lamp.'),
      turn(3, 'user', `Here is what your site lists, which shade would fit? ${catalogue}`),
      turn(4, 'assistant', 'The Ember takes the washed linen shade, 30 cm.'),
      turn(5, 'user', 'Replacement please. Send it to my office, 14 Harbour Street, Leith.'),
      turn(
        6,
        'assistant',
        "I'll arrange a replacement shade to 14 Harbour Street and email you a tracking number by Friday."
      ),
      turn(
        7,
        'user',
        'Actually send it home, 3 Rowan Close, Leith. The office is closed next week.'
      ),
      turn(8, 'assistant', 'Noted: 3 Rowan Close, Leith.'),
      turn(9, 'user', "Please don't call me, email only."),
      turn(10, 'assistant', 'Email only, noted.')
    ],
    expected: [
      {
        key: 'customer-order',
        value: 'Lena Ortiz, order 71402, Ember lamp shade cracked',
        sources: [1]
      },
      { key: 'resolution', value: 'replacement shade chosen, not refund', sources: [5] },
      { key: 'address', value: '3 Rowan Close, Leith, replacing 14 Harbour Street', sources: [7] },
      {
        key: 'open-commitment',
        value: 'assistant promised to email a tracking number by Friday',
        sources: [6]
      },
      { key: 'contact', value: 'email only, no calls', sources: [9] }
    ],
    stale: ['14 Harbour Street as the current address'],
    notDone: ['replacement shipped', 'tracking number sent']
  },
  {
    id: 'S2',
    domain: 'support',
    sources: [
      turn(
        1,
        'user',
        'Tomasz from Kestrel Labs, account KL-2291. We were charged twice for September.'
      ),
      turn(2, 'assistant', 'Which invoices were charged twice?'),
      turn(3, 'user', 'INV-8812 and INV-8813, both €480.'),
      turn(4, 'user', `For reference, your pricing page says: ${plans}`),
      turn(
        5,
        'assistant',
        "I see both. I've asked billing to refund INV-8813; they reply within 2 business days."
      ),
      turn(6, 'user', "Also, we're switching to annual billing from October."),
      turn(
        7,
        'assistant',
        "Annual billing needs an account admin's approval; I'll send you the form."
      ),
      turn(8, 'user', 'Correction: we stay on monthly billing for now, our CFO said no.'),
      turn(9, 'assistant', 'Understood, you stay on monthly billing.'),
      turn(10, 'user', 'And the billing contact is finance@kestrel.io, not me.'),
      turn(11, 'assistant', 'Noted: billing contact finance@kestrel.io.')
    ],
    expected: [
      { key: 'account', value: 'Kestrel Labs, account KL-2291, Tomasz', sources: [1] },
      {
        key: 'open-refund',
        value:
          'refund of duplicate INV-8813 (€480) requested from billing, reply within 2 business days; not confirmed',
        sources: [3, 5]
      },
      {
        key: 'billing-period',
        value: 'stays monthly; the annual switch was withdrawn',
        sources: [8]
      },
      { key: 'billing-contact', value: 'finance@kestrel.io', sources: [10] }
    ],
    stale: ['annual billing as the current plan'],
    notDone: ['refund issued', 'approval form sent']
  },
  {
    id: 'D1',
    domain: 'devops',
    sources: [
      turn(
        1,
        'user',
        'Dana here. Change freeze: no prod deploys from Friday 15:00 UTC to Monday 08:00 UTC.'
      ),
      turn(2, 'user', 'Deploy checkout v2.14.0 to staging.'),
      turn(3, 'assistant', 'Staging deploy of checkout v2.14.0 requested.'),
      turn(4, 'user', `Staging log:\n${deployLog}`),
      turn(
        5,
        'user',
        'Staging looks good. Keep the limit from that log: replica lag must stay under 5 s during the prod rollout. Prod target is cluster eu-west-2.'
      ),
      turn(
        6,
        'user',
        'Ravi: correction, prod moved to eu-central-1 last week; eu-west-2 is read-only.'
      ),
      turn(7, 'assistant', 'Noted: prod target is eu-central-1.'),
      turn(
        8,
        'user',
        'Dana: approved, prod deploy of checkout v2.14.0 on Thursday after 10:00 UTC.'
      ),
      turn(9, 'user', 'Also rotate the Stripe webhook secret before 3 October, ticket OPS-311.'),
      turn(10, 'assistant', "I'll add a reminder for OPS-311.")
    ],
    expected: [
      {
        key: 'freeze',
        value: 'no prod deploys Friday 15:00 UTC to Monday 08:00 UTC (Dana)',
        sources: [1]
      },
      { key: 'cluster', value: 'prod cluster eu-central-1, replacing eu-west-2', sources: [6] },
      {
        key: 'approval',
        value:
          'Dana approved prod deploy of checkout v2.14.0, Thursday after 10:00 UTC; not yet deployed',
        sources: [8]
      },
      {
        key: 'limit',
        value: 'replica lag under 5 s during the prod rollout (taken from the staging log)',
        sources: [5]
      },
      {
        key: 'open-task',
        value: 'rotate the Stripe webhook secret before 3 October, OPS-311',
        sources: [9]
      }
    ],
    stale: ['eu-west-2 as the prod cluster'],
    notDone: ['deployed to prod', 'secret rotated']
  },
  {
    id: 'D2',
    domain: 'devops',
    sources: [
      turn(1, 'user', `Alert for payments-api:\n${metrics}`),
      turn(2, 'user', "Ravi: I'm incident commander for INC-4471."),
      turn(3, 'user', 'Ravi: decision, scale payments-api to 6 replicas.'),
      turn(4, 'assistant', 'Scale of payments-api to 6 replicas requested.'),
      turn(5, 'user', 'Ravi: quota allows only 4 in this namespace; make it 4, not 6.'),
      turn(6, 'assistant', 'Scale target for payments-api is now 4 replicas.'),
      turn(
        7,
        'user',
        "Ravi: I suspect the db-proxy pool size of 20. Don't change it until Mei (DBA) reviews."
      ),
      turn(8, 'user', 'Ravi: Mei takes over as incident commander at 18:00 UTC.'),
      turn(9, 'user', 'Ravi: postmortem due 6 October, owner Ravi.'),
      turn(10, 'user', `Runbook for reference: ${runbook}`),
      turn(11, 'assistant', 'Noted.')
    ],
    expected: [
      {
        key: 'incident',
        value: 'INC-4471, commander Ravi; Mei takes over at 18:00 UTC',
        sources: [2, 8]
      },
      {
        key: 'scale',
        value: 'scale payments-api to 4 replicas (quota), replacing 6; requested, not confirmed',
        sources: [5]
      },
      {
        key: 'constraint',
        value: 'do not change the db-proxy pool size (20) until Mei reviews',
        sources: [7]
      },
      { key: 'open-task', value: 'postmortem due 6 October, owner Ravi', sources: [9] }
    ],
    stale: ['6 replicas as the current target'],
    notDone: ['payments-api scaled', 'Mei already commander without the 18:00 time']
  }
];

const genericPrompt =
  'Compact the supplied conversation records into JSON only: {"facts":[{"value":{},"sourceSeqs":[1]}],"summary":"..."}. Keep as facts what will matter later in this conversation: stable facts about the people, systems or objects involved; constraints and preferences; decisions that were made; and requests, approvals or commitments that are still open. Name each fact\'s subject exactly as the records do (a person, account, order, service, cluster, ticket). When a later record corrects an earlier one, keep only the corrected value and say what it replaces. Do not copy reference material such as catalogues, logs, metrics, specifications or pasted documents; keep only a constraint, parameter or decision that the conversation explicitly takes from it. A request, plan, approval, promise or confirmation is not evidence that an action was done: record it as requested, approved or promised, with its source. Use at most 5 facts; each value is a flat object of short strings or numbers. Each fact must cite the sequence numbers of the records it comes from. The summary must be brief and must preserve the meaning of the previous summary.';

module.exports = { chunks, genericPrompt };
