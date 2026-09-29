# First connected Agent

Four small scripts that run one order-support Agent with a local model:

- `agent.js` — the Template config and the `getOrder` action with its handler.
- `setup.js` — creates the Template and Agent once and prints the Agent ID.
- `executor.js` — a long-lived process that runs the Agent's turns on your machine.
- `ask.js` — sends one message and prints the answer and the actions it called.

`getOrder` reads a two-line in-memory map; it is a stand-in, not an order system. Replace its handler with a call to your service before real traffic, and keep the name and schemas unless you also rerun `setup.js`.

## Before you start

- Node 18 or later and a clone of this repository with `npm install`. The connected SDK is not published to npm.
- A team with managed Agents enabled.
- An OpenAI-compatible model endpoint. With Ollama: `ollama pull qwen2.5:7b-instruct`, endpoint `http://127.0.0.1:11434/v1`. Managed executors do not call the Anthropic API natively yet.

## Steps

1. In the cabinet, open your Space → **Agent Center** → **Space keys** → **Manage**, and press **Create app key** and **Create executor key**. You need the owner or admin role; no Agent has to exist yet. Each secret is shown once. Keep both keys on servers, never in a browser.

2. Set the environment in one shell:

   ```sh
   export NULLPROTOCOL_APP_KEY=np_space_...       # App server key
   export NULLPROTOCOL_EXECUTOR_KEY=np_space_...  # Executor key
   export MODEL_BASE_URL=http://127.0.0.1:11434/v1
   export MODEL_NAME=qwen2.5:7b-instruct
   ```

   `MODEL_API_KEY` is optional; set `MODEL_TOOL_CALLS=false` for a model without native tool calls.

3. Create the Agent and keep its ID. Rerunning with the same `agent.js` returns the same Agent:

   ```sh
   node examples/managed/starter/setup.js
   export NULLPROTOCOL_AGENT_ID=...   # the printed ID
   ```

   The Agent also appears in the cabinet. Create it here rather than in the cabinet: the executor only serves an Agent whose action schemas match the handlers in `agent.js` exactly.

4. Start the executor in a second shell with the same environment and leave it running:

   ```sh
   node examples/managed/starter/executor.js
   ```

   It prints `registered` once the API accepts it, logs transient problems such as an unreachable model or API, and keeps polling. Ctrl+C stops it with exit code 0. It exits with code 1 when the API rejects the key or its manifest, or when its Agent is deleted.

5. Ask:

   ```sh
   node examples/managed/starter/ask.js "My name is Stan. Where is order 42?" customer-1
   # action getOrder (read): succeeded
   # Order 42 has shipped and should arrive tomorrow.
   ```

   The second argument is the conversation key. Runs with the same key share history and facts; use your user or ticket ID. The Agent's **Runs** tab shows the same run with its steps, and **Ask** sends a message from the cabinet.

6. Restart the executor and ask in the same conversation. Memory lives in the Space, not in the process:

   ```sh
   node examples/managed/starter/ask.js "What is my name?" customer-1
   ```

7. In the cabinet, open the Agent's **Context** tab and add an entry, for example a signature rule. The next run reads it; no restart is needed.

8. Pause the Agent in the cabinet (Overview): `ask.js` prints `agent_paused`. Resume it to continue. Deleting the Agent permanently removes its conversations, context and traces, and the executor exits.

If `ask.js` prints `runtime_offline`, `action_unavailable` or `model_unavailable`, it also says which step to fix. `client.agent(id).runtime()` reports the same readiness without starting a run; it reflects what the executor registered, not whether the model endpoint works.

`npm run test:starter` runs these steps end to end against an isolated database and a local model.
