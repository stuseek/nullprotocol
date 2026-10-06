# Named agents over HTTP

Optional: use this only if you want to expose your agents over HTTP. The primitives above need no server, database or NullProtocol account.

`serveAgents` runs agents defined in code behind one HTTP service. One stateless agent on a local model:

```js
import { serveAgents } from 'nullprotocol';

serveAgents({
  apiKey: process.env.HTTP_ACCESS_KEY, // your own secret; callers send it as a Bearer token
  agents: [
    {
      id: 'support',
      mode: 'stateless',
      operations: ['chat'],
      provider: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b-instruct'
    }
  ]
});
```

It listens on `127.0.0.1:3000` (set `port` and `host`, or `PORT`). Call `POST /v1/agents/support/invoke` with `Authorization: Bearer <HTTP_ACCESS_KEY>` and `{ "operation": "chat", "input": { "prompt": "Hello" } }`. The outer `apiKey` protects your HTTP service and is never sent to a model; each agent definition takes the same `provider`, `model`, `apiKey` and `baseURL` as the constructor, and its `apiKey` is the model key. Extraction schemas are defined in the agent configuration, never in request bodies.

Optionally, an agent can keep a conversation: give it `mode: 'stateful'` and the service a `store`. A caller creates a session with `POST /v1/agents/:id/sessions`, then posts to `.../sessions/:sessionId/messages`.

| You want | Store |
| --- | --- |
| Stateless HTTP agents | None |
| Conversation history in one process | `store: new MemorySessionStore()`; history is lost on restart |
| Shared or persistent sessions across processes | Your PostgreSQL with `new PostgresSessionStore(pool)` |

The CLI runs an exported configuration from a project where the package is installed: `npx --package=nullprotocol@1.3.0 nullprotocol-serve --config ./agents.js`.

<details>
<summary>Multiple processes and runtime controls</summary>

**PostgreSQL sessions.** Apply `sql/session-store.sql` to your database and pass `new PostgresSessionStore(pool)` with a `pg.Pool`. Sessions expire after 24 hours of inactivity. Each turn holds a lease, so a concurrent write to the same session returns `session_busy`.

**Access per caller.** Routes require the HTTP `apiKey`, or an `authenticate(req)` hook returning `{ principal, agents, canManage }` for per-caller access.

**Stopping.** `POST /v1/agents/:id/stop` disables an agent and cancels its active runs. `server.shutdown({ drainTimeoutMs, cancelTimeoutMs })` drains gracefully.

**Tool callbacks.** They receive `principal`, `agentId`, `sessionId`, `runId`, `callId` and an abort signal. Heed the signal, and use idempotency keys for side effects.

**Cabinet controls, optional.** With `runtimeKey`, this HTTP service reports its agents to a NullProtocol Space so the cabinet can pause, resume or stop them. It is not needed to run the service.

**Older single-agent adapter.** `serve({ apiKey, port, ...clientOptions })` exposes `POST /extract`, `/validate`, `/summarize`, `/decide`, `/chat` and `GET /health`, binds to `127.0.0.1` and requires a Bearer token. Its `apiKey` is that HTTP token, so with `provider` the model key comes from `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and an `openai-compatible` server gets no key.

</details>
