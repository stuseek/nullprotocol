const {
  shouldCompact,
  targetSequence,
  sourceChunk,
  parseCompaction,
  consolidateFacts
} = require('../managed-compaction');

test('old conversation records can be compacted while keeping recent turns', () => {
  const messages = Array.from({ length: 32 }, (_, index) => ({
    seq: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content:
      index === 5
        ? {
            text: 'Done',
            actionOutcomes: [
              { name: 'refund', runId: 'run-1', callId: 'call-1', status: 'succeeded' }
            ]
          }
        : `message ${index + 1}`
  }));
  const conversation = { messages, window: { truncated: false, fromSeq: 1, toSeq: 32 } };
  expect(shouldCompact(conversation)).toBe(true);
  expect(targetSequence(conversation)).toBe(20);
  const first = sourceChunk(messages);
  expect(first).toHaveLength(16);
  expect(first[5].content.actionOutcomes[0].status).toBe('succeeded');
});

test('a legal maximum-size message can still be a source for compaction', () => {
  const content = 'x'.repeat(32766);
  expect(Buffer.byteLength(JSON.stringify(content))).toBe(32768);
  const message = { seq: 1, role: 'user', content };
  expect(Buffer.byteLength(JSON.stringify(message))).toBeGreaterThan(32768);
  expect(sourceChunk([message])).toEqual([message]);
});

test('compaction rejects facts citing messages the executor did not receive', () => {
  const sources = [{ seq: 12, role: 'user', content: 'Order ID 42' }];
  expect(() =>
    parseCompaction(
      '{"facts":[{"value":{"orderId":"42"},"sourceSeqs":[11]}],"summary":"Asked about an order."}',
      sources
    )
  ).toThrow('invalid_compaction');
  expect(
    parseCompaction(
      '{"facts":[{"value":{"orderId":"42"},"sourceSeqs":[12]}],"summary":"Asked about an order."}',
      sources
    )
  ).toEqual({
    facts: [{ value: { orderId: '42' }, sourceSeqs: [12] }],
    summary: 'Asked about an order.'
  });
  expect(() =>
    parseCompaction(
      '{"facts":[{"value":{"actionOutcome":{"status":"succeeded"}},"sourceSeqs":[12]}],"summary":"Asked about an order."}',
      sources
    )
  ).toThrow('invalid_compaction');
});

test('fact consolidation keeps exact source values and provenance when the cap is reached', () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `fact-${index}`,
    value: { orderId: String(index) },
    sourceSeqs: [index + 1]
  }));
  const result = consolidateFacts(existing, [{ value: { orderId: 'new' }, sourceSeqs: [101] }]);
  expect(result.factsRemove).toHaveLength(2);
  expect(result.factsAdd).toHaveLength(2);
  expect(result.factsAdd[1]).toEqual({
    value: {
      items: [
        { value: { orderId: '0' }, sourceSeqs: [1] },
        { value: { orderId: '1' }, sourceSeqs: [2] }
      ]
    },
    sourceSeqs: [1, 2]
  });
});
