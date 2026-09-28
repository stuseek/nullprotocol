const { createHash, randomUUID } = require('crypto');
const { NullProtocolClient, ManagedExecutor } = require('../../src');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}

async function runExample({
  slug,
  name,
  instructions,
  actions = [],
  input,
  conversation,
  context
}) {
  const endpoint = process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai';
  const modelName = required('MODEL_NAME');
  const eventId = process.env.EVENT_ID || randomUUID();
  const modelBaseURL = required('MODEL_BASE_URL');
  const executorKey = required('NULLPROTOCOL_EXECUTOR_KEY');
  const config = {
    instructions,
    model: { provider: 'local', model: modelName, credentialRef: 'localModel' },
    actions,
    memory: { mode: 'conversation' }
  };
  const configId = createHash('sha256')
    .update(
      JSON.stringify({
        name,
        instructions,
        model: config.model,
        actions: actions.map(({ handler: _handler, guard: _guard, ...contract }) => contract),
        memory: config.memory
      })
    )
    .digest('hex')
    .slice(0, 16);
  const client = new NullProtocolClient({
    spaceKey: required('NULLPROTOCOL_APP_KEY'),
    endpoint
  });
  const { template } = await client.templates.create(
    {
      name,
      config
    },
    { idempotencyKey: `example:${slug}:template:${configId}` }
  );
  const { agent } = await client.agents.create(
    { templateId: template.id, name },
    { idempotencyKey: `example:${slug}:agent:${configId}` }
  );
  const executor = new ManagedExecutor({
    executorKey,
    endpoint,
    agentIds: [agent.id],
    actions,
    credentials: {
      localModel: {
        provider: 'local',
        baseURL: modelBaseURL,
        ...(process.env.MODEL_API_KEY ? { apiKey: process.env.MODEL_API_KEY } : {})
      }
    }
  });
  await executor.start();
  try {
    const run = await client.agent(agent.id).run(input, {
      conversation,
      ...(context ? { context } : {}),
      idempotencyKey: eventId
    });
    console.log(
      JSON.stringify(
        {
          agentId: agent.id,
          runId: run.id,
          status: run.status,
          output: run.output,
          errorCode: run.errorCode
        },
        null,
        2
      )
    );
  } finally {
    await executor.stop();
  }
}

module.exports = { runExample };
