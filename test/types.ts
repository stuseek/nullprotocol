import {
  NullProtocol,
  AgentError,
  type Agent,
  type Extraction,
  type Usage,
  type Result
} from 'nullprotocol';

async function useAgent(agent: Agent) {
  const order: Extraction<{ orderId: number }> = await agent.extract<{ orderId: number }>(
    'Order 42',
    { orderId: 'number' }
  );
  if (order.success) {
    const id: number = order.data.orderId;
    const usage: Usage | undefined = order.usage;
    void [id, usage];
    // @ts-expect-error A successful extraction is not a failed operation.
    order.errorCode;
  } else {
    const code: string = order.errorCode;
    void code;
    // @ts-expect-error A failed extraction has no data.
    order.data;
  }
  const summary: Result<{ summary: string }> = await agent.summarize('A short ticket.');
  void summary;
  agent.registerAction('review', async (_parameters, context) => context.input);
  const decision = await agent.decide('Review this ticket.', ['review']);
  if (decision.success) await agent.execute(decision);
  return NullProtocol.load({ key: 'space-key', agentId: agent.agentId });
}

const error = new AgentError('invalid_options', 'Choose a model.', { field: 'model' });
void [useAgent, error];
// @ts-expect-error An unknown provider is not supported.
void NullProtocol.create({ provider: 'unknown', model: 'test' });
// @ts-expect-error Loading needs the Space SDK key.
void NullProtocol.load({ agentId: 'support' });

async function manageKnowledge(agent: Agent) {
  const revision = await agent.knowledge.add({ name: 'Policy', text: '30 days.' });
  const source = await agent.knowledge.get(revision.id);
  const state: 'ready' | 'preparing' | 'failed' = source.state;
  await agent.knowledge.update(source.id, { text: '14 days.', ifVersion: source.version });
  await agent.knowledge.delete(source.id, { ifVersion: source.version });
  await agent.knowledge.connect(source.id);
  await agent.knowledge.disconnect(source.id);
  await agent.knowledge.connections();
  const usage = await agent.space.knowledge.usage();
  const tokens: string | null = usage.search;
  return { state, tokens };
}
void manageKnowledge;
