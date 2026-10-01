# Changelog

## 1.0.0

First npm release of `nullprotocol`. Earlier 2.x versions were source releases on GitHub; their history is in Git.

- Local primitives `extract`, `validate`, `summarize`, `decide` and `chat` with schema validation, decision allowlists and guards, bounded tool calls, retries, timeouts and a circuit breaker.
- Connected managed Agents: `NullProtocolClient` for Templates, Agents, runs, context and memory, and `ManagedExecutor` for running them in your infrastructure with checked, traced actions.
- Named agents over HTTP with `serveAgents`, memory or PostgreSQL session stores, and optional runtime control.
- Optional metadata-only telemetry and shared Space context.
