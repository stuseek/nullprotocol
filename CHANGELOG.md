# Changelog

## 1.2.0

- A client in your application can be paused, resumed and stopped from the cabinet with `runtimeKey`, `runtimeEndpoint` and an explicit `agentId`. A paused agent's operations return `agent_paused` without calling the model; stop cancels running operations, including streams and tool callbacks, through their abort signal. The first operation waits for the agent's state, and the last confirmed state holds through an outage.
- Refused operations are reported in telemetry with their code and wait time. They need the API that accepts these codes.
- `close()` releases a client's control connection and flushes its telemetry.
- `serveAgents` and clients share one control connection per runtime key in a process.

## 1.1.0

- Configure the model with `provider` (`openai`, `anthropic` or `openai-compatible`), `model`, `apiKey` and `baseURL`. A local server needs no key and never receives a cloud key from the environment; cloud providers use their own endpoint and key variable. Configuration errors are thrown by the constructor. The `engines` form from 1.0.0 keeps working and cannot be mixed with `provider`.
- A per-call `model` with `provider` is the model's name, not an alias.
- `basePrompt` set in a config file is now used, and `withContext` and `forDomain` keep the effective configuration without reading the file again.

## 1.0.0

First npm release of `nullprotocol`. Earlier 2.x versions were source releases on GitHub; their history is in Git.

- Local primitives `extract`, `validate`, `summarize`, `decide` and `chat` with schema validation, decision allowlists and guards, bounded tool calls, retries, timeouts and a circuit breaker.
- Connected managed Agents: `NullProtocolClient` for Templates, Agents, runs, context and memory, and `ManagedExecutor` for running them in your infrastructure with checked, traced actions.
- Named agents over HTTP with `serveAgents`, memory or PostgreSQL session stores, and optional runtime control.
- Optional metadata-only telemetry and shared Space context.
