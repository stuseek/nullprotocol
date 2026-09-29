# Moving from the 2.6 local API to connected Agents

The connected API is deployed for allowlisted teams and the connected SDK is on the GitHub `main` branch. The package is not published to npm. Existing 2.6 applications do not need to migrate; this guide describes an explicit move to managed Agents.

Install `git+https://github.com/stuseek/nullprotocol.git` and use a Space key from an allowlisted team. The SDK defaults to `https://api.nullprotocol.ai`; set `NULLPROTOCOL_API_URL` only for a separate test API.

## What changes

| 2.6 source package | Connected Agent |
| --- | --- |
| `new NullProtocol({ engines, models })` runs a primitive in your process | `new NullProtocolClient({ spaceKey })` manages a Space and submits runs to the API |
| `extract`, `validate`, `summarize`, `decide`, `chat` are direct calls | A versioned Agent Template defines instructions, model, actions and memory policy; `agent.run(input, { conversation })` starts a managed run |
| `serveAgents` exposes an HTTP service you host | `ManagedExecutor` connects outbound to the API and executes runs for one or more explicit Agent IDs |
| Chat history or a session store belongs to the local process/service | Each conversation key under a managed Agent has isolated history, facts and summary in the Space |
| Local `spaceContext` is optional | The managed API stores selected Space Context, Agent Context and explicit Agent memory |

The old constructor and primitives remain in the 2.6 source package. There is no automatic conversion of local sessions, prompts, tool handlers or Space Context keys.

## Migration sequence

1. Create two Space keys. The app server needs `templates:write`, `agents:write`, `agents:read`, `runs:create` and `runs:read`. Code that reads or changes Agent Context or memory also needs `context:read` and `context:write`; conversation inspection and deletion need `conversations:read` and `conversations:delete`. The executor needs `runtime:connect` and `runs:execute`. Keep both keys on servers; never put them in a browser bundle.
2. Move stable instructions, model choice, action schemas and memory policy into an Agent Template. Publish a new Template version to change them. Existing Agents stay pinned until explicitly repinned.
3. Create each long-lived Agent explicitly and retain its ID. One executor process can serve many Agent IDs; a process is not spawned per Agent.
4. Register local action handlers with `defineAction`. Pass the same definition to the Template and `ManagedExecutor`; the SDK publishes only its schema and description. Keep application data, permission checks and idempotent side effects in your code.
5. Replace an in-process Agent call with `agent.run(input, { conversation, idempotencyKey })`. Derive the conversation key from your authenticated user or case ID. The application must authorize that mapping; a Space key can address all conversations in its Space.
6. Inspect runs and steps, then switch traffic by application route. Do not import old chat transcripts as facts without source and isolation checks. Keep the old 2.6 path available until your own runs, actions and deletion flows have been verified.

For a first Agent that stays connected, follow the [starter](../examples/managed/starter/README.md): setup, a long-lived executor, and asks with memory across restarts. See single-request source examples for [support](../examples/managed/support.js), [game dialogue](../examples/managed/game.js), and [DevOps](../examples/managed/devops.js). Set `NULLPROTOCOL_APP_KEY`, `NULLPROTOCOL_EXECUTOR_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME` before running one. `MODEL_API_KEY` is optional for a local OpenAI-compatible model endpoint. Each launch gets a new request ID; set `EVENT_ID` to a fixed value to test idempotent replay. The examples create a Template and Agent with stable creation keys derived from their config, serve a single request, and stop the executor. Free Spaces allow three managed Agents, so running all three examples uses the full Agent quota. If you edit a config, the example creates another Template and Agent. The output prints its `agentId`; remove an old demo Agent with `await client.agents.delete(agentId)` before running a replacement. Deletion permanently removes that Agent's conversations, context, memory and traces. Use a durable application process for real traffic.

## Behavior to check before switching traffic

- `agent.run()` returns a terminal run. A `failed` or `unknown` result is not a successful answer. Read its `errorCode` and steps.
- A write handler receives `idempotencyKey` and must use it in the system performing the write. An ambiguous write stays `unknown` until you reconcile it. Do not infer that a timeout means the write failed.
- Conversation compaction preserves sourced facts and a bounded recent window. If it cannot catch up, the run may answer from incomplete memory, but write actions are blocked for that run. An oversized model request can also omit older facts or turns; its `context` step reports what was left out. Check `agent.conversations.get(key).conversation.memoryState` and the run steps. Delete unnecessary facts or messages, or the conversation, to recover from exhausted capacity.
- `client.usage()` reports Space limits, current usage, known token totals and `runsWithoutUsage`. The token numbers are observability data, not billing or model cost.
- Deleting an Agent or conversation removes its managed history and linked content. For large histories, deletion completes asynchronously; wait for the API's deletion state before assuming all content is gone.

No npm publication, public signup, paid managed inference or hosted executor is implied by this guide.
