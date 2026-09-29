// The Agent's contract and local handlers, shared by setup.js and executor.js
// so both declare the same action hashes.
const { defineAction } = require('../../../src');

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

// A different name creates a separate Template and Agent in setup.js.
const name = process.env.NULLPROTOCOL_AGENT_NAME || 'Order support';
const actions = [getOrder];

function config(modelName) {
  return {
    instructions:
      'Help the customer with order questions. Read current order data before answering. Never claim an order was changed.',
    model: { provider: 'local', model: modelName, credentialRef: 'localModel' },
    actions,
    memory: { mode: 'conversation' }
  };
}

function required(variable) {
  const value = process.env[variable];
  if (!value) throw new Error(`Set ${variable}`);
  return value;
}

const endpoint = process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai';

module.exports = { name, actions, config, required, endpoint };
