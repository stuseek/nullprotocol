import { NullProtocol } from 'nullprotocol';

// A local catalogue for this example. Replace the handlers with your API/database calls.
const catalogue = [
  { id: 42, name: 'Blue mug', price: 14, currency: 'EUR' },
  { id: 73, name: 'White mug', price: 12, currency: 'EUR' }
];

try {
  if (process.env.NULLPROTOCOL_KEY && !process.env.NULLPROTOCOL_AGENT_ID) {
    throw new Error('Set NULLPROTOCOL_AGENT_ID with your Space SDK key.');
  }
  const agent = process.env.NULLPROTOCOL_KEY
    ? await NullProtocol.load({
        key: process.env.NULLPROTOCOL_KEY,
        agentId: process.env.NULLPROTOCOL_AGENT_ID,
        ...(process.env.NULLPROTOCOL_SCOPE_ID
          ? { conversation: process.env.NULLPROTOCOL_SCOPE_ID }
          : {})
      })
    : await NullProtocol.create({
        provider: 'ollama',
        model: process.env.NULLPROTOCOL_MODEL || 'qwen2.5:3b-instruct',
        baseURL: process.env.NULLPROTOCOL_MODEL_URL || 'http://localhost:11434',
        instructions:
          'Choose one offered action. Use search_catalog for product requests; otherwise prepare a short reply with send_message.',
        timeout: 120000
      });

  agent.registerAction('send_message', ({ text }) => ({ message: text }), {
    description: 'Prepare a short reply to the incoming message',
    input: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false
    }
  });
  agent.registerAction(
    'search_catalog',
    ({ query, maxPrice }) =>
      catalogue.filter(
        product =>
          product.name.toLowerCase().includes(query.toLowerCase()) &&
          (maxPrice === undefined || product.price <= maxPrice)
      ),
    {
      description: 'Find products by a word in their name and optional maximum price in EUR',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          maxPrice: { type: 'number', minimum: 0 }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  );

  const input = process.argv.slice(2).join(' ') || 'Hello!';
  const decision = await agent.decide(input, ['send_message', 'search_catalog']);
  if (!decision.success) throw new Error(`${decision.errorCode}: ${decision.error}`);
  if (decision.historyError) {
    console.error('Decision History:', decision.historyError);
    process.exitCode = 1;
  }

  const execution = await agent.execute(decision);
  if (!execution.success) throw new Error(`${execution.errorCode}: ${execution.error}`);
  console.log(JSON.stringify({ action: execution.action, result: execution.result }, null, 2));
  if (decision.usage) console.log('Generation usage:', decision.usage);
  if (execution.historyError) {
    console.error('Execution History:', execution.historyError);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.code || 'example_failed', error.message);
  process.exitCode = 1;
}
