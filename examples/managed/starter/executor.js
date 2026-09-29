// Long-lived executor for one Agent. Runs until SIGINT/SIGTERM (exit 0) or
// until the API rejects it (exit 1); transient API or model errors are
// logged and polling continues.
const { ManagedExecutor } = require('../../../src');
const { actions, required, endpoint } = require('./agent');

async function main() {
  const executor = new ManagedExecutor({
    executorKey: required('NULLPROTOCOL_EXECUTOR_KEY'),
    endpoint,
    agentIds: [required('NULLPROTOCOL_AGENT_ID')],
    actions,
    credentials: {
      localModel: {
        provider: 'local',
        baseURL: required('MODEL_BASE_URL'),
        ...(process.env.MODEL_API_KEY ? { apiKey: process.env.MODEL_API_KEY } : {}),
        // Models without native tool calls use the SDK's JSON text protocol.
        ...(process.env.MODEL_TOOL_CALLS === 'false' ? { toolCalls: false } : {})
      }
    },
    onError: code => console.error(`executor: ${code}`)
  });
  await executor.start();
  console.log(`executor ${executor.instanceId} connected`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void executor.stop());
  const { reason } = await executor.closed;
  console.log(`executor closed: ${reason}`);
  process.exitCode = reason === 'stopped' ? 0 : 1;
}

main().catch(error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
