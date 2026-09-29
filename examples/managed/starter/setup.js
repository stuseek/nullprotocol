// Creates the Template and Agent once and prints the Agent ID. Rerunning with
// the same config returns the same Agent.
const { createHash } = require('crypto');
const { NullProtocolClient } = require('../../../src');
const { name, config, required, endpoint } = require('./agent');

async function main() {
  const client = new NullProtocolClient({ spaceKey: required('NULLPROTOCOL_APP_KEY'), endpoint });
  const body = { name, config: config(required('MODEL_NAME')) };
  const configId = createHash('sha256')
    .update(
      JSON.stringify({
        ...body,
        config: {
          ...body.config,
          actions: body.config.actions.map(({ handler: _handler, ...contract }) => contract)
        }
      })
    )
    .digest('hex')
    .slice(0, 16);
  const { template } = await client.templates.create(body, {
    idempotencyKey: `starter:template:${configId}`
  });
  const { agent } = await client.agents.create(
    { templateId: template.id, name },
    { idempotencyKey: `starter:agent:${configId}` }
  );
  console.log(`NULLPROTOCOL_AGENT_ID=${agent.id}`);
}

main().catch(error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
