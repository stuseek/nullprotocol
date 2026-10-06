# Managed Agents (allowlisted beta)

`NullProtocolClient` manages Templates, Agents and runs in a Space. In a Template's `model`, `credentialRef` names the executor credential to use and `provider` is a label that must equal that credential's `provider` for the executor to count as compatible. The executor calls any OpenAI-compatible endpoint; this `provider` is not the constructor's `provider` above. `ManagedExecutor` is an outbound process in your infrastructure that runs them: it holds the model credentials and action handlers, and can serve several Agents, one run at a time. Access requires an allowlisted team. The quickest start is the cabinet: create an Agent, create an executor key, and copy the files from the Agent's Connect tab. [examples/managed/starter](../examples/managed/starter/README.md) does the same in code.

```js
import { NullProtocolClient, ManagedExecutor, defineAction } from 'nullprotocol';
const orders = new Map([['42', { status: 'shipped' }]]);

const getOrder = defineAction({
  name: 'getOrder',
  description: 'Read one order',
  effect: 'read',
  input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  output: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
  handler: async ({ id }) => orders.get(id) || { status: 'unknown' }
});

const app = new NullProtocolClient({ spaceKey: process.env.NULLPROTOCOL_APP_KEY });
const { template } = await app.templates.create({
  name: 'Support',
  config: {
    instructions: 'Help the customer with their order.',
    model: { provider: 'local', model: 'your-model', credentialRef: 'localModel' },
    actions: [getOrder]
  }
}, { idempotencyKey: 'support-template-v1' });
const { agent } = await app.agents.create({ templateId: template.id }, { idempotencyKey: 'support-agent-v1' });

const executor = new ManagedExecutor({
  executorKey: process.env.NULLPROTOCOL_EXECUTOR_KEY,
  agentIds: [agent.id],
  actions: [getOrder],
  credentials: { localModel: { provider: 'local', baseURL: 'http://127.0.0.1:11434/v1' } }
});
await executor.start();

const run = await app.agent(agent.id).run('Where is order 42?', {
  conversation: 'ticket:opaque-id',
  idempotencyKey: 'message:opaque-id'
});
console.log(run.status, run.output?.text);
```

The app key needs `templates:write`, `agents:write`, `agents:read`, `runs:create` and `runs:read`, plus `context:read`, `context:write`, `conversations:read` and `conversations:delete` for the memory APIs. The executor key needs only `runtime:connect` and `runs:execute`. `NULLPROTOCOL_API_URL` overrides the default `https://api.nullprotocol.ai`. For a local model without native tool calling, add `toolCalls: false` to its credential; the model then answers with a `decide`-style JSON object that goes through the same checks.

What a run guarantees:

- **Actions are checked before they run.** The model's arguments and the handler's output are validated against the action's JSON Schemas. An optional guard (five-second limit) must return `true`. A call that fails a check, names a disabled action, or would write while earlier context is missing does not run; the run's steps record it, and the model is told so it can decline, ask, or correct the call.
- **Writes carry idempotency keys and recorded outcomes.** A `write` handler receives an `idempotencyKey`, `runId`, `callId` and an abort signal; your handler must use the key in the system that performs the write. A started write that cannot be confirmed is recorded as `unknown` and blocks further writes with the same action name in that conversation until you call `agent.reconcileStep(runId, ordinal, { outcome, note })`.
- **A succeeded run means the interaction finished**, not that a requested action happened. Read the run's steps to see what was done.
- **Memory is bounded.** `agent.context.put` and `agent.memory.add` store current data and long-term notes for an Agent; older conversation messages are compacted into sourced facts by the model, which can lose or distort them. When a request would exceed the model budget, the oldest facts and turns are left out of that request (not deleted), the model is told memory is incomplete, a `context` step records what was omitted, and write actions are unavailable for that turn.
- **Retention is opt-in.** A Template can set `retention: { agentIdleDays: 30 }`; the Agent and all its content are deleted 30 days after it was created or last ran, whichever is later. Database backups have their own retention.

`agent.cancelRun(runId)` cancels a server run; `agent.setAction(name, { disabled: true, ifRevision })` disables an action without changing the Template. More shapes are in [examples/managed](../examples/managed) and the [upgrade guide](upgrade-managed.md).
