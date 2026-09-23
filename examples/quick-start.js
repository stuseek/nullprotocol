/**
 * NullProtocol quick start. Set MODEL_BASE_URL and MODEL_NAME for a local
 * OpenAI-compatible server, or use OPENAI_API_KEY with a hosted model.
 */
const { NullProtocol } = require('../src');

async function main() {
  const ai = new NullProtocol({
    engines: { openai: process.env.OPENAI_API_KEY || 'local' },
    openaiBaseURL: process.env.MODEL_BASE_URL || 'http://127.0.0.1:1234/v1',
    models: { openai: process.env.MODEL_NAME || 'your-model' },
    retry: { maxRetries: 2 },
    timeout: 20_000
  });

  const result = await ai.extract('Order 42: two blue mugs', {
    orderId: 'number',
    quantity: 'number',
    item: 'string'
  });

  if (!result.success) {
    console.error('Could not extract a valid order:', result.error);
    process.exitCode = 1;
    return;
  }

  console.log(result.data);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
