# Changelog

## 1.4.0 — 2026-10-07

- Managed Agents: an Agent Context entry can be `inclusion: 'selected'`, sent only to the runs that name its key in `contextKeys`. A selected entry holds up to 64 KiB.
- `ManagedExecutor` no longer leaves Agent Context or memory out of a request that is too large: the run fails with `model_context_too_large`. Older conversation facts and turns are still left out first.
- `ManagedExecutor` records on each model step the request it sent: its size against the budget, and the Agent Context entries it carried for the first time in the run, by key and version. A run's `contextRefs` are built from these.
- A credential can set `maxPromptBytes`, the request budget for a model with a small window. The room kept for action calls and results is a share of that budget, so a small budget no longer drops every action.
- Context refreshed during a run is no longer replaced by a note when it does not fit: the run fails with `model_context_too_large`.
- Runnable refund, invoice and SLA examples show the model extracting facts while code applies rules and calculations.

## 1.3.1

- Every operation's result has `usage: { inputTokens, outputTokens }`, summed over its model requests, when the provider reports token counts for all of them. `serveAgents` returns it in `output`.
- `validate` accepts its one result object wrapped in an array, as `decide` already does; small models answer this way when the subject is a list.
- After its cooldown the circuit breaker lets one request through to test the provider: its success closes the breaker and its failure starts a new cooldown. A request that began before a trip can no longer close or reopen it.

## 1.3.0

- `connectOpenAI(client, options)` from `nullprotocol/openai` reports an existing OpenAI client's `chat.completions.create` calls to Activity, one `model.call` event each, and with a runtime key lets the cabinet pause and stop them. Parameters, completions and errors stay the SDK's own; a stream comes back as an async iterable of its chunks. Works with `openai` 4 to 7.
- The package declares its entry points: `nullprotocol`, `nullprotocol/openai` and `nullprotocol/package.json`. Imports of other files inside the package no longer resolve.
- The README starts with connecting an existing OpenAI client.

## 1.2.1

- Telemetry names the model of every model request and reports its own failure: `timeout`, `rate_limited`, `aborted` or `provider_error`.
- `extract` and `decide` send their final event also when they fail with an error, coded by where they stopped: the failed request's code, `aborted` for a cancelled request, `config_error` for input that failed before any model request, and `internal` otherwise.
- The README starts with connecting an application to a Space and reading Activity, and the Named agents over HTTP heading is back.

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
