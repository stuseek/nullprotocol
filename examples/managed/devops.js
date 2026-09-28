const { defineAction } = require('../../src');
const { runExample } = require('./common');

// Replace these in-process records with your logs and durable deployment API.
const logs = [
  { service: 'checkout', level: 'error', message: 'database connection timed out' },
  { service: 'checkout', level: 'warn', message: 'retry queue growing' }
];
const restarts = new Map();
const readLogs = defineAction({
  name: 'readLogs',
  description: 'Read recent application logs for one service',
  effect: 'read',
  input: {
    type: 'object',
    properties: { service: { type: 'string' } },
    required: ['service'],
    additionalProperties: false
  },
  output: { type: 'array', items: { type: 'object' } },
  handler: async ({ service }) => logs.filter(line => line.service === service)
});
const restartService = defineAction({
  name: 'restartService',
  description: 'Restart an approved service after the operator authorizes it',
  effect: 'write',
  input: {
    type: 'object',
    properties: { service: { type: 'string' } },
    required: ['service'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { receipt: { type: 'string' } },
    required: ['receipt'],
    additionalProperties: false
  },
  guard: async (_args, context) => context.runContext?.restartApproved === true,
  handler: async ({ service }, context) => {
    // A production handler must persist the idempotency key in the system doing the write.
    if (!restarts.has(context.idempotencyKey)) {
      restarts.set(context.idempotencyKey, { receipt: `${service}:${context.callId}` });
    }
    return restarts.get(context.idempotencyKey);
  }
});

runExample({
  slug: 'devops',
  name: 'Incident operator',
  instructions:
    'Investigate incidents from current evidence. Read logs before diagnosing. Only restart a service when the application grants approval.',
  actions: [readLogs, restartService],
  input: 'Why is checkout failing? Check the logs and summarize the likely cause.',
  conversation: 'incident:checkout-demo',
  context: { restartApproved: false }
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
