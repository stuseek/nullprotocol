// The shop both the ordinary app and the managed Agent act on: the same
// orders, action contracts, refund policy guard and idempotent handler.

const orders = {
  1042: { status: 'shipped', eta: 'Friday', total: 64 },
  2210: { status: 'delivered', eta: 'delivered on Monday', total: 89 },
  3307: { status: 'processing', eta: 'next Tuesday', total: 120 },
  4415: { status: 'shipped', eta: 'tomorrow', total: 35 }
};

const contracts = {
  getOrder: {
    name: 'getOrder',
    description: 'Read the current status, delivery estimate and total of one order by its number',
    effect: 'read',
    input: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The order number' } },
      required: ['id'],
      additionalProperties: false
    },
    output: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        eta: { type: 'string' },
        total: { type: 'number' }
      },
      required: ['status'],
      additionalProperties: false
    }
  },
  refund: {
    name: 'refund',
    description: 'Refund an amount in dollars for one order. Only for delivered orders.',
    effect: 'write',
    input: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'The order number' },
        amount: { type: 'number', description: 'Amount in dollars' }
      },
      required: ['orderId', 'amount'],
      additionalProperties: false
    },
    output: {
      type: 'object',
      properties: { refundId: { type: 'string' }, amount: { type: 'number' } },
      required: ['refundId', 'amount'],
      additionalProperties: false
    }
  }
};

// One shop per case: executions are the refunds that actually happened.
function createShop() {
  const refunded = new Map();
  const byKey = new Map();
  const executions = [];
  const attempts = [];
  const calls = [];
  return {
    executions,
    attempts,
    calls,
    getOrder: ({ id }) => {
      calls.push({ name: 'getOrder', arguments: { id } });
      const order = orders[id];
      return order
        ? { status: order.status, eta: order.eta, total: order.total }
        : { status: 'not_found' };
    },
    // Business policy, identical in both arms.
    guard: ({ orderId, amount }) => {
      attempts.push({ orderId, amount });
      const order = orders[orderId];
      return Boolean(
        order &&
        order.status === 'delivered' &&
        amount > 0 &&
        amount <= order.total &&
        !refunded.has(orderId)
      );
    },
    refund: ({ orderId, amount }, { idempotencyKey }) => {
      calls.push({ name: 'refund', arguments: { orderId, amount } });
      if (byKey.has(idempotencyKey)) return byKey.get(idempotencyKey);
      const result = { refundId: `R-${orderId}-${executions.length + 1}`, amount };
      executions.push({ orderId, amount });
      refunded.set(orderId, result);
      byKey.set(idempotencyKey, result);
      return result;
    }
  };
}

const instructions = `You are the support assistant for Northwind Home, an online home goods shop.
Policies: returns within 30 days with the receipt; standard shipping takes 3-5 business days; express shipping takes 1-2 business days and costs $12. Refunds are only possible for delivered orders, up to the order total.
Look up an order with getOrder before describing it. Use refund only when the customer asks for one and the policy allows it.
Answer in at most three sentences.`;

module.exports = { orders, contracts, createShop, instructions };
