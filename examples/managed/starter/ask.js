// node ask.js "Where is order 42?" [conversation]
// Prints the answer and the actions the run called.
const { NullProtocolClient } = require('../../../src');
const { required, endpoint } = require('./agent');

const hints = {
  runtime_offline: 'No executor is connected for this Agent. Start executor.js.',
  action_unavailable:
    'The connected executor declares different actions. Restart it after changing agent.js, and rerun setup.js.',
  model_unavailable: 'The connected executor has no localModel credential for this Agent.',
  agent_paused: 'The Agent is paused. Resume it in the cabinet.',
  agent_not_found: 'The Agent does not exist. Rerun setup.js and use the printed ID.'
};

async function main() {
  const [input, conversation = 'starter'] = process.argv.slice(2);
  if (!input) throw new Error('Usage: node ask.js "question" [conversation]');
  const client = new NullProtocolClient({ spaceKey: required('NULLPROTOCOL_APP_KEY'), endpoint });
  const agent = client.agent(required('NULLPROTOCOL_AGENT_ID'));
  const run = await agent.run(input, { conversation });
  const { steps } = await agent.listSteps(run.id);
  for (const step of steps.filter(({ kind }) => kind === 'action')) {
    console.log(`action ${step.payload.name} (${step.payload.effect}): ${step.status}`);
  }
  if (run.status !== 'succeeded') {
    throw Object.assign(new Error(run.status), { code: run.errorCode });
  }
  console.log(run.output.text);
}

main().catch(error => {
  console.error(error.code || error.message);
  if (hints[error.code]) console.error(hints[error.code]);
  process.exitCode = 1;
});
