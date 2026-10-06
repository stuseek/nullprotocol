# Activity, telemetry and control

Give each AI step in your code an `agentId` and connect it to a Space: its calls appear in Activity under that ID, and the cabinet can pause or stop it. Create the keys under **Connect** in the cabinet: an ingest key for telemetry and, for pause and stop, a runtime key.

### An existing OpenAI client

Code that already calls `openai.chat.completions.create` can keep its requests, tool loop and error handling and report each call through `nullprotocol/openai`:

```js
import OpenAI from 'openai';
import { connectOpenAI } from 'nullprotocol/openai';

const openai = new OpenAI();
const support = connectOpenAI(openai, {
  agentId: 'support',
  telemetryKey: process.env.NULLPROTOCOL_TELEMETRY_KEY,
  telemetryEndpoint: 'https://api.nullprotocol.ai',
  // Optional, for pause and stop from the cabinet:
  // runtimeKey: process.env.NULLPROTOCOL_RUNTIME_KEY,
  // runtimeEndpoint: 'https://api.nullprotocol.ai'
});

try {
  // In place of openai.chat.completions.create
  const completion = await support.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: 'Where is order 58213?' }]
  });
  console.log(completion.choices[0].message.content);
} finally {
  await support.close();
}
```

- `create` passes the parameters to your client unchanged, and the request options too except `signal`, which it combines with stop and `close()`. It returns your client's completion, or throws its error, as they are. The client's retries, timeout and defaults stay as you set them.
- It returns a plain Promise, so `.withResponse()` and `.asResponse()` are not available; call your client directly for those, and that call is not reported.
- With `stream: true` it returns an async iterable of the SDK's chunks, not the SDK's `Stream`: there is no `controller`, `tee()` or `toReadableStream()`. Leaving the loop early closes the connection.
- Each call is one `model.call` event in Activity with the requested model, its duration, the token counts the provider reported and, on failure, `aborted`, `rate_limited`, `timeout`, `provider_error` or `internal`. A completed call means the model request completed; nothing checks the reply. No prompt or reply is sent.
- With a runtime key, a paused agent's `create` throws a `ControlError` without sending a request, and Stop cancels the `create` calls in flight, streams included. It does not stop your code between calls, such as running tools: a loop ends when its next `create` is refused.

### With the SDK's operations

With the SDK's own operations, give each client an `agentId` and the same settings:

```js
import { NullProtocol } from 'nullprotocol';

const support = new NullProtocol({
  agentId: 'support',
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  telemetry: true,
  telemetryEndpoint: 'https://api.nullprotocol.ai',
  telemetryKey: process.env.NULLPROTOCOL_TELEMETRY_KEY,
  runtimeKey: process.env.NULLPROTOCOL_RUNTIME_KEY,
  runtimeEndpoint: 'https://api.nullprotocol.ai'
});

try {
  const result = await support.extract('Order 42: two blue mugs', {
    orderId: 'number',
    quantity: 'number',
    item: 'string'
  });
  console.log(result);
} finally {
  await support.close(); // sends buffered events and releases the control connection
}
```

For `extract` and `decide`, each model request is one `ai_request` event with the model's name, and the operation sends one final event, also when it fails with an error; all share one run ID. `chat` with tools reports one `ai_request` for all its tool rounds. Activity holds metadata only: prompts, replies and the failing field stay in your application's result.

| Activity shows | What happened |
| --- | --- |
| `ai_request` failed with `timeout`, `rate_limited` or `provider_error`, and `extract` or `decide` with the same code | The model request failed |
| `ai_request` succeeded, then `extract` or `decide` with `schema_mismatch` | The model answered and the answer did not pass the check; each attempt, including a repair turn, is its own `ai_request` |
| `ai_request` succeeded, then `decide` with `guard_rejected` | Your guard refused the model's choice |
| `extract` or `decide` with `config_error` and no `ai_request` | The input failed before any model request, such as an invalid schema |
| An operation with `agent_paused` and no `ai_request` | The agent is paused in the cabinet |
| `ai_request` and `extract` or `decide` with `aborted` | The request was cancelled, for example by Stop in the cabinet |

Without the telemetry and runtime settings the same client runs locally with no account; see [Local primitives](operations.md).

## Optional telemetry

Telemetry is off by default. With `telemetry: true`, an HTTPS `telemetryEndpoint` and a `telemetryKey`, the client sends operation metadata and reported token usage, never prompts, replies, tool parameters or credentials. For the hosted API, use `https://api.nullprotocol.ai` with a Space ingest key from the [cabinet](https://app.nullprotocol.ai/), and keep the key on your server.

```js
const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  telemetry: true,
  telemetryEndpoint: 'https://api.nullprotocol.ai',
  telemetryKey: process.env.NULLPROTOCOL_TELEMETRY_KEY
});
await ai.telemetry?.destroy(); // flush before shutdown; delivery is best effort
```

Events go to `/api/telemetry` unless you set `telemetryPath`. Up to 1,000 events are buffered. `telemetryTimeline: true` adds one metadata event per top-level call with up to 24 model, tool and guard steps.

## Pause and stop from the cabinet

A client in your application can be paused, resumed and stopped from the cabinet. Give it an `agentId` and a runtime key from **Connect → Runtime keys**:

```js
const ops = new NullProtocol({
  agentId: 'ops',
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  runtimeKey: process.env.NULLPROTOCOL_RUNTIME_KEY,
  runtimeEndpoint: 'https://api.nullprotocol.ai'
});
// ...
await ops.close(); // on shutdown
```

- **Pause:** new operations of that agent return `{ success: false, errorCode: 'agent_paused' }` without calling the model, and a stream raises a `ControlError` when read. Running ones finish.
- **Stop:** pauses the agent and requests cancellation of its running operations: their model requests are aborted, and no retry, repair turn or further tool round starts. Cancellation is cooperative for your code: a tool callback receives the abort `signal` and must stop its own work, and effects already made are not undone.
- **Connection:** the first operation waits up to 10 seconds for the agent's state and returns `control_unavailable` if it gets none, so a restart cannot skip a pause. After that the last confirmed state holds while the API is unreachable, and new commands apply on reconnect. A refused runtime key returns `control_rejected`.
- Clients with the same `agentId`, in one process or many, are one agent in the cabinet. With telemetry on, a refused operation is reported with its code.
