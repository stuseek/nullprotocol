const assert = require('node:assert/strict');
const { NullProtocol } = require('../src/index');

const model = process.env.NULLPROTOCOL_MODEL;
if (!model) {
  throw new Error('Set NULLPROTOCOL_MODEL to a model available at the local endpoint.');
}

const ai = new NullProtocol({
  defaultEngine: 'openai',
  engines: { openai: process.env.NULLPROTOCOL_MODEL_KEY || 'local' },
  openaiBaseURL:
    process.env.NULLPROTOCOL_MODEL_URL ||
    process.env.NULLPROTOCOL_OPENAI_BASE_URL ||
    'http://127.0.0.1:11434/v1',
  models: { openai: model },
  debug: false,
  temperature: 0,
  maxTokens: 400,
  timeout: 120_000,
  retry: { maxRetries: 0 },
  telemetry: false
});

async function check(name, run, verify) {
  const start = Date.now();
  const result = await run();
  assert.equal(result.success, true, `${name}: ${result.error || 'operation failed'}`);
  verify(result);
  console.log(`${name}: one sample passed (${Date.now() - start} ms)`);
}

async function main() {
  await check(
    'chat',
    () => ai.chat('Reply with exactly: HELLO'),
    result => {
      assert.match(result.message, /HELLO/);
    }
  );

  await check(
    'extract',
    () =>
      ai.extract('Order 42: two blue mugs', {
        orderId: 'number',
        quantity: 'number',
        item: 'string'
      }),
    result => {
      assert.equal(result.data.orderId, 42);
      assert.equal(result.data.quantity, 2);
    }
  );

  await check(
    'validate',
    () =>
      ai.validate('Payment must be captured and stock reserved.', {
        payment: 'captured',
        stock: 'reserved'
      }),
    result => {
      assert.equal(result.recommendation, 'pass');
      assert.ok(result.score >= 0.5);
    }
  );

  await check(
    'validate negative',
    () =>
      ai.validate('Payment must be captured and stock reserved.', {
        payment: 'declined',
        stock: 'unavailable'
      }),
    result => assert.equal(result.recommendation, 'fail')
  );

  await check(
    'summarize',
    () =>
      ai.summarize(
        'At 10:00 UTC the API error rate rose to 30% after deployment. The database remained healthy. A rollback at 10:06 UTC restored normal traffic.',
        { maxLength: 180 }
      ),
    result => assert.match(result.summary, /rollback/i)
  );

  const actions = ['inspect_logs', 'restart_service', 'do_nothing'];
  await check(
    'decide',
    () => ai.decide({ service: 'api', errorRate: 0.35 }, actions),
    result => assert.notEqual(result.action, 'do_nothing')
  );

  const toolCalls = [];
  await check(
    'tool',
    () =>
      ai.chat('Use get_order for order 42, then say its status.', {
        tools: [
          {
            name: 'get_order',
            description: 'Look up an order by ID',
            parameters: {
              type: 'object',
              properties: { id: { type: 'number' } },
              required: ['id']
            }
          }
        ],
        onToolCall: async (name, parameters) => {
          toolCalls.push({ name, parameters });
          return { id: 42, status: 'shipped' };
        }
      }),
    result => {
      assert.deepEqual(toolCalls, [{ name: 'get_order', parameters: { id: 42 } }]);
      assert.match(result.message, /shipped/i);
    }
  );
  console.log('Single-run smoke only; it does not measure decision quality or reliability.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
