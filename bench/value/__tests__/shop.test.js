const { createShop } = require('../shop');

test('the handler refuses an illegal refund with no effect', () => {
  const shop = createShop();
  expect(shop.refund({ orderId: '3307', amount: 40 }, { idempotencyKey: 'k1' })).toEqual({
    status: 'rejected',
    reason: 'order_not_delivered'
  });
  expect(shop.refund({ orderId: '1042', amount: 500 }, { idempotencyKey: 'k2' })).toMatchObject({
    status: 'rejected'
  });
  expect(shop.executions).toEqual([]);
  expect(shop.counters).toMatchObject({ handlerEntries: 2, handlerRefusals: 2 });
});

test('a legal refund commits once, and a replay returns the original result', () => {
  const shop = createShop();
  const first = shop.refund({ orderId: '2210', amount: 89 }, { idempotencyKey: 'k1' });
  expect(first).toEqual({ status: 'refunded', refundId: 'R-2210-1', amount: 89 });
  // The order is now refunded; replaying the same authorized request must
  // not turn into a refusal.
  expect(shop.refund({ orderId: '2210', amount: 89 }, { idempotencyKey: 'k1' })).toEqual(first);
  expect(shop.refund({ orderId: '2210', amount: 10 }, { idempotencyKey: 'k1' })).toMatchObject({
    reason: 'idempotency_key_reused'
  });
  expect(shop.refund({ orderId: '2210', amount: 89 }, { idempotencyKey: 'k2' })).toMatchObject({
    reason: 'already_refunded'
  });
  expect(shop.executions).toEqual([{ orderId: '2210', amount: 89 }]);
  expect(shop.counters).toMatchObject({ handlerEntries: 2, handlerRefusals: 1, replays: 2 });
});

test('guard and handler share the policy and count separately', () => {
  const shop = createShop();
  expect(shop.guard({ orderId: '3307', amount: 40 })).toBe(false);
  expect(shop.guard({ orderId: '2210', amount: 89 })).toBe(true);
  expect(shop.counters).toMatchObject({ guardRefusals: 1, handlerEntries: 0 });
});
