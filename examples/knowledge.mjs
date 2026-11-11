// Set NULLPROTOCOL_KEY and create a saved support agent first. Uses hosted tokens.
// Stages one temporary source, connects it only after preparation, then cleans it up.
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: 'support'
});
const source = await agent.space.knowledge.add({
  name: 'Temporary SDK policy example',
  text: '# Returns\nUnused goods may be returned within 30 days.'
});
let connected = false;
try {
  await agent.space.knowledge.waitUntilReady(source, { timeout: 30000 });
  await agent.knowledge.connect(source.id);
  connected = true;
  const result = await agent.extract(
    'Within how many days can unused goods be returned?',
    { days: 'number' },
    { knowledge: { query: 'Return window for unused goods' } }
  );
  if (!result.success) throw new Error(`${result.errorCode}: ${result.error}`);
  console.log(result.data);
  console.log('Evidence:', result.knowledge);
  console.log('Generation:', result.usage, 'Search:', result.knowledgeUsage);
} finally {
  if (connected) {
    await agent.knowledge
      .disconnect(source.id)
      .catch(error => console.error('Disconnect:', error.message));
  }
  // Use our known version, not a freshly read version of somebody else's edit.
  await agent.space.knowledge
    .delete(source.id, { ifVersion: source.version })
    .catch(error => console.error('Source cleanup:', error.message));
}
