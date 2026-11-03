import { NullProtocol } from 'nullprotocol';

if (!process.env.NULLPROTOCOL_KEY || !process.env.NULLPROTOCOL_AGENT_ID) {
  console.error('Set NULLPROTOCOL_KEY and NULLPROTOCOL_AGENT_ID from your agent’s Connect panel.');
  process.exitCode = 1;
} else {
  try {
    const agent = await NullProtocol.load({
      key: process.env.NULLPROTOCOL_KEY,
      agentId: process.env.NULLPROTOCOL_AGENT_ID
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
    if (result.historyError) console.error('History:', result.historyError);
  } catch (error) {
    console.error(error.code || 'setup_failed', error.message);
    process.exitCode = 1;
  }
}
