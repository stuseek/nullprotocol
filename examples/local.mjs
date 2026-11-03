import { NullProtocol } from 'nullprotocol';

try {
  const agent = await NullProtocol.create({
    provider: 'ollama',
    model: process.env.NULLPROTOCOL_MODEL || 'qwen2.5:3b-instruct',
    ...(process.env.NULLPROTOCOL_MODEL_URL ? { baseURL: process.env.NULLPROTOCOL_MODEL_URL } : {}),
    instructions: 'Read orders. Use only facts in the supplied text.',
    timeout: 120000
  });
  const result = await agent.extract('Order 42: two blue mugs.', {
    orderId: 'number',
    quantity: 'number',
    item: 'string'
  });
  if (result.success) {
    console.log(result.data);
    if (result.usage) console.log(result.usage);
  } else {
    console.error(result.errorCode, result.error);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.code || 'setup_failed', error.message);
  process.exitCode = 1;
}
