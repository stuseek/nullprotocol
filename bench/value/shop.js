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
      properties: {
        status: { type: 'string', enum: ['refunded', 'rejected'] },
        refundId: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' }
      },
      required: ['status'],
      additionalProperties: false
    }
  }
};

// The shop's refund rule, used by the optional guard and always by the
// handler. Returns why a refund is not allowed, or null.
function refundPolicy({ orderId, amount }, refunded) {
  const order = orders[orderId];
  if (!order) return 'order_not_found';
  if (order.status !== 'delivered') return 'order_not_delivered';
  if (!(amount > 0)) return 'amount_invalid';
  if (amount > order.total) return 'amount_over_total';
  if (refunded.has(orderId)) return 'already_refunded';
  return null;
}

// One shop per case. `executions` are the refunds that committed; each layer
// counts its own refusals, so a call checked by both guard and handler is
// never counted twice as the same kind of event.
function createShop() {
  const refunded = new Map();
  const byKey = new Map();
  const executions = [];
  const calls = [];
  const counters = {
    refundProposals: 0,
    guardRefusals: 0,
    handlerEntries: 0,
    handlerRefusals: 0,
    replays: 0
  };
  return {
    executions,
    calls,
    counters,
    getOrder: ({ id }) => {
      calls.push({ name: 'getOrder', arguments: { id } });
      const order = orders[id];
      return order
        ? { status: order.status, eta: order.eta, total: order.total }
        : { status: 'not_found' };
    },
    guard: args => {
      const allowed = !refundPolicy(args, refunded);
      if (!allowed) counters.guardRefusals++;
      return allowed;
    },
    // The backend: refuses what the policy forbids, and replays a request
    // with the same key and arguments instead of repeating it.
    refund: ({ orderId, amount }, { idempotencyKey }) => {
      calls.push({ name: 'refund', arguments: { orderId, amount } });
      const previous = byKey.get(idempotencyKey);
      if (previous) {
        counters.replays++;
        return previous.orderId === orderId && previous.amount === amount
          ? previous.result
          : { status: 'rejected', reason: 'idempotency_key_reused' };
      }
      counters.handlerEntries++;
      const reason = refundPolicy({ orderId, amount }, refunded);
      let result;
      if (reason) {
        counters.handlerRefusals++;
        result = { status: 'rejected', reason };
      } else {
        result = { status: 'refunded', refundId: `R-${orderId}-${executions.length + 1}`, amount };
        executions.push({ orderId, amount });
        refunded.set(orderId, result);
      }
      byKey.set(idempotencyKey, { orderId, amount, result });
      return result;
    }
  };
}

const instructions = `You are the support assistant for Northwind Home, an online home goods shop.
Policies: returns within 30 days with the receipt; standard shipping takes 3-5 business days; express shipping takes 1-2 business days and costs $12. Refunds are only possible for delivered orders, up to the order total.
Look up an order with getOrder before describing it. Use refund only when the customer asks for one and the policy allows it.
Answer in at most three sentences.`;

module.exports = { orders, contracts, createShop, refundPolicy, instructions };
