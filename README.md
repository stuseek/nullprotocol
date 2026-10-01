<img src="assets/nullprotocol.png" alt="NullProtocol" width="88" height="88" />

# NullProtocol

A Node.js library for model calls with local checks: structured output validated against a JSON Schema, decisions limited to the actions you allow, an optional guard, bounded tool calls, retries and timeouts. It also connects managed Agents to the NullProtocol API, with their model credentials and actions kept in your own executor process.

[![CI](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml/badge.svg)](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-205c42)](LICENSE)

The library is MIT licensed and runs without an account. Telemetry, shared Space context and managed Agents are optional and use the separate NullProtocol API.

## Install

```sh
npm install git+https://github.com/stuseek/nullprotocol.git 'openai@^4.104.0'
```

Node.js 18 or newer is required. The pinned OpenAI SDK works on Node 18; on Node 22 you can install the current one. Install `@anthropic-ai/sdk` instead if you use Anthropic.

## Local primitives

Point the OpenAI client at any compatible endpoint, including a local model server:

```js
const { NullProtocol } = require('nullprotocol');

const ai = new NullProtocol({
  engines: { openai: process.env.MODEL_API_KEY || 'local' },
  openaiBaseURL: process.env.MODEL_BASE_URL || 'http://127.0.0.1:11434/v1',
  models: { openai: process.env.MODEL_NAME || 'your-model' },
  timeout: 20_000
});

const result = await ai.extract('Order 42: two blue mugs', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});
if (result.success) console.log(result.data);
else console.error(result.error); // ask again, use a stronger model, or send for review
```

| Operation | Result | Local check |
| --- | --- | --- |
| `extract(data, schema)` | Structured data | JSON Schema validation |
| `validate(criteria, subject)` | Score and reasoning | Score and confidence ranges, recommendation enum |
| `summarize(content)` | Summary and key points | Response shape, length, confidence range |
| `decide(context, actions)` | Selected action | Membership in the allowed list, confidence range |
| `chat(prompt)` | Text or tool calls | Nonempty response, tool allowlist |

Operations return `{ success, ... }`; model and validation failures are `{ success: false, error }`, so check `success` before acting. A refused, truncated or content-filtered reply is a failure, never partial text. Validation catches malformed output; it cannot prove the extracted facts are true.

When `extract` gets invalid JSON or a schema mismatch, or `decide` gets an action outside the list, the model is shown the exact problem and asked once more. Set `repairAttempts` (0 to 3, default 1) on the constructor or per call. Results report `attempts` and `repaired`. A repair fixes the reply's form, not its facts.

### Extraction schemas

A schema is shorthand or JSON Schema:

```js
// Shorthand: every key is a required field, so this has a field named "items".
await ai.extract(text, { vendor: 'string', items: 'string[]' });

// JSON Schema is used as is.
await ai.extract(text, {
  type: 'object',
  properties: { id: { type: 'string' }, note: { type: 'string' } },
  required: ['id']
});

// A nested object made only of schema keywords is JSON Schema: here address is a string.
await ai.extract(text, { address: { type: 'string' } });
```

To name a single nested field `type`, write that object as JSON Schema. An invalid schema fails before the model is called.

### Decisions with hard rules

The action list checks the shape of a model's choice, not whether it is right. For rules, pass an application-owned `guard`; only `true` accepts the decision, and a rejected one has `action: null` and is not retried.

```js
const metrics = { errorRatePercent: 35 }; // from your monitoring, not from model input
const decision = await ai.decide({ ...metrics, logLine }, ['inspect_logs', 'monitor'], {
  guard: ({ action }) => action === (metrics.errorRatePercent > 20 ? 'inspect_logs' : 'monitor')
});
```

Asynchronous guards have a 30-second deadline (`guardTimeoutMs`) and receive an abort `signal`.

### Tool calls and actions

```js
const response = await ai.chat('Look up order 42', {
  tools: [{
    name: 'get_order',
    description: 'Read an order by ID',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  }],
  onToolCall: async (name, params) => orderStore.get(params.id)
});
```

Only offered tool names reach `onToolCall`, for at most ten rounds. Retries apply to each model request, so a transient error does not rerun a tool. Validate parameters and permissions in your callback before side effects.

Registered actions can require confirmation from your application:

```js
ai.registerAction('send_email', sendEmail, { requiresConfirmation: true });
await ai.execute(decision, { confirm: async (action, parameters) => askUserToApprove(action, parameters) });
```

Without an approving callback, `execute` throws `ConfirmationRequiredError` and the handler is not called.

### Models, history and context size

`models` can hold aliases (`{ openai: 'default-model', cheap: 'small-model' }`) selected per call with `{ model: 'cheap' }`; choosing and falling back stays in your code. With `trackHistory: true`, `chat` keeps history per instance, so use one instance per conversation. `{ stream: true }` returns an async generator; add `collect: true` for a normal result. `maxContextLength` (characters) drops the oldest chat turns before a request and fails if the system text and current input alone do not fit.

Claude 4.7 and later accept no sampling parameters, so `temperature` is sent only to older Claude models. The Anthropic default model is `claude-sonnet-5`.

### Checking a local model

```sh
NULLPROTOCOL_MODEL=qwen2.5:7b-instruct npm run smoke:local
```

This calls Ollama's OpenAI-compatible endpoint once per operation and once with a tool. It checks format, not model quality. `npm test` never calls paid model APIs; set `NULLPROTOCOL_LIVE_TESTS=1` with provider keys to run the live suite. Benchmark runs with local 3B and 7B models are in [bench](bench/README.md), with the [frozen 48-task result](bench/published/frozen-qwen-2026-09-24.md) and other [published results](bench/published).

## Managed Agents (allowlisted beta)

`NullProtocolClient` manages Templates, Agents and runs in a Space. `ManagedExecutor` is an outbound process in your infrastructure that runs them: it holds the model credentials and action handlers, and can serve several Agents, one run at a time. Access requires an allowlisted team. The quickest start is the cabinet: create an Agent, create an executor key, and copy the files from the Agent's Connect tab. [examples/managed/starter](examples/managed/starter/README.md) does the same in code.

```js
const { NullProtocolClient, ManagedExecutor, defineAction } = require('nullprotocol');
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

`agent.cancelRun(runId)` cancels a server run; `agent.setAction(name, { disabled: true, ifRevision })` disables an action without changing the Template. More shapes are in [examples/managed](examples/managed) and the [upgrade guide](docs/upgrade-managed.md).

## Shared Space context

Agents in one Space can share small versioned JSON documents through a separate context key, independent of telemetry and your model provider:

```js
const ai = new NullProtocol({
  engines: { openai: process.env.MODEL_API_KEY },
  spaceContextKey: process.env.NULLPROTOCOL_SPACE_CONTEXT_KEY
});
const current = await ai.spaceContext.get('ops', 'last-check');
await ai.spaceContext.put('ops', 'last-check', { status: 'ok' }, {
  ifVersion: current?.version ?? null,
  ttlSeconds: 3600
});
```

`ifVersion: null` creates a document; a stale version throws `SpaceContextError` with `status: 409`. A Space holds up to 100 documents of 4 KiB each. Values are never added to prompts automatically, and the API stores them until deletion or expiry, so avoid secrets and personal data.

## Optional telemetry

Telemetry is off by default. With `telemetry: true`, an HTTPS `telemetryEndpoint` and a `telemetryKey`, the client sends operation metadata and reported token usage, never prompts, replies, tool parameters or credentials. For the hosted API, use `https://api.nullprotocol.ai` with a Space ingest key from the [cabinet](https://app.nullprotocol.ai/), and keep the key on your server.

```js
const ai = new NullProtocol({
  engines: { openai: process.env.OPENAI_API_KEY },
  telemetry: true,
  telemetryEndpoint: process.env.TELEMETRY_ENDPOINT,
  telemetryKey: process.env.TELEMETRY_KEY
});
await ai.telemetry?.destroy(); // flush before shutdown; delivery is best effort
```

Events go to `/api/telemetry` unless you set `telemetryPath`. Up to 1,000 events are buffered. `telemetryTimeline: true` adds one metadata event per top-level call with up to 24 model, tool and guard steps.

## Named agents over HTTP

`serveAgents` runs agents defined in code behind one HTTP service:

```js
const { serveAgents, MemorySessionStore } = require('nullprotocol');

serveAgents({
  apiKey: process.env.NULLPROTOCOL_API_KEY,
  store: new MemorySessionStore(),
  agents: [
    { id: 'support', mode: 'stateless', operations: ['chat'],
      engines: { openai: process.env.OPENAI_API_KEY }, models: { openai: 'your-model' } },
    { id: 'game-character', mode: 'stateful', basePrompt: 'You are the merchant in the game.',
      engines: { openai: process.env.OPENAI_API_KEY }, models: { openai: 'your-model' } }
  ]
});
```

Call `POST /v1/agents/support/invoke` with `{ "operation": "chat", "input": { "prompt": "Hello" } }`. A stateful agent first creates a session with `POST /v1/agents/:id/sessions`, then posts to `.../sessions/:sessionId/messages`. Extraction schemas are defined in the agent configuration, never in request bodies. Routes require the API key or an `authenticate(req)` hook returning `{ principal, agents, canManage }` for per-caller access.

For several processes, apply `sql/session-store.sql` to your PostgreSQL database and use `new PostgresSessionStore(pool)`. Sessions expire after 24 hours of inactivity, and each turn holds a lease, so concurrent writes to one session return `session_busy`. `POST /v1/agents/:id/stop` disables an agent and cancels its active runs; `server.shutdown({ drainTimeoutMs, cancelTimeoutMs })` drains gracefully. Tool callbacks receive `principal`, `agentId`, `sessionId`, `runId`, `callId` and an abort signal; heed the signal and use idempotency keys for side effects. With `runtimeKey`, the service reports its agents to a Space so the cabinet can pause, resume or stop them.

The CLI runs an exported configuration from a project where the package is installed: `npx --package=nullprotocol nullprotocol-serve --config ./agents.js`.

The older single-agent adapter `serve({ apiKey, engines, port })` exposes `POST /extract`, `/validate`, `/summarize`, `/decide`, `/chat` and `GET /health`, binds to `127.0.0.1` and requires a Bearer token.

## Moving from `@stuseek/ai-toolkit`

Install this package, change the import, and use `NullProtocol` in new code; `AIToolkit` remains an export alias. The old token-only cloud mode reports a configuration error.

## Development

`npm run validate` runs lint, formatting and tests. `npm run test:managed-integration` checks the SDK against the API repository checked out next to this one (`../api`), using its separate `TEST_DATABASE_URL`; it refuses to run when that equals `DATABASE_URL`.

## License

MIT. See [LICENSE](LICENSE).
