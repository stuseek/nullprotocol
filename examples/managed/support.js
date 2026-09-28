const { defineAction } = require('../../src');
const { runExample } = require('./common');

// Replace this map with your application's order service.
const orders = new Map([['42', { status: 'shipped', eta: 'tomorrow' }]]);
const getOrder = defineAction({
  name: 'getOrder',
  description: 'Read the current status of one order',
  effect: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { status: { type: 'string' }, eta: { type: 'string' } },
    required: ['status'],
    additionalProperties: false
  },
  handler: async ({ id }) => orders.get(id) || { status: 'not_found' }
});

runExample({
  slug: 'support',
  name: 'Order support',
  instructions:
    'Help the customer with order questions. Read current order data before answering. Never claim an order was changed.',
  actions: [getOrder],
  input: 'Where is order 42?',
  conversation: 'ticket:42'
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
