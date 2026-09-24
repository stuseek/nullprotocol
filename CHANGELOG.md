# Changelog

## 2.3.0 — source release; npm publication pending

- Add opt-in, metadata-only run timelines for Team Spaces with `telemetryTimeline: true`. One bounded trace covers a top-level nonstreaming call, including model, tool, and decision-guard steps. The standalone library still works without hosted telemetry.

## 2.2.0 — source release; npm publication pending

Breaking behavior for the named HTTP service: its stored history budget is 8,192 rough tokens per agent (previously 50,000), `MemorySessionStore` allows 2,000 total sessions (previously 10,000), and `/readyz` stays 200 when every agent is disabled. Configure `maxHistoryTokens` or `maxSessions` to restore the earlier limits.

- Keep `/readyz` reachable when all agents are disabled so operators can enable them again.
- Reject request strings that PostgreSQL cannot store and repair invalid model characters in saved session history.
- Refresh a session's expiry when a turn starts; validate named-agent history budgets and retain the current turn when older history is trimmed.
- Let a transient session-lease renewal error retry on the next heartbeat; the final commit remains conditional on a valid lease.

## 2.1.2 — source release; npm publication pending

- Drop telemetry events that cannot be serialized or correlated without changing the result of an agent call.

## 2.1.1 — source release; npm publication pending

- Parse JSON with braces and brackets inside quoted strings without accepting a nested fragment from a truncated response.
- Accept an unambiguous single-object array in `decide`, while still checking the action allowlist and application guard.
- Add a local two-model comparison pilot with raw per-task results and independent scoring. It does not support a broad model-quality claim.

## 2.1.0 — source release; npm publication pending

- Add opt-in shared Space context with explicit versioned JSON reads, writes, and deletion.
- Keep its Space-scoped read/write key separate from telemetry and managed inference keys. No shared value is added to a model request automatically.
- Expose `SpaceContextClient` and `SpaceContextError` for applications that do not need an AI runtime instance.

## 2.0.0 — source release; npm publication pending

Breaking changes: named HTTP agents omit `toolCalls` from responses unless `exposeToolCalls: true`. The legacy `serve()` adapter ignores caller-supplied model options and hides provider errors. Session stores now cap active sessions per principal at 1,000 by default; `PostgresSessionStore` requires `pg.Pool`.

- Accept current OpenAI and Anthropic SDK peers while keeping an install path for Node 18.
- Keep version scripts from staging unrelated files or pushing automatically.
- Count provider and network failures, rather than caller errors, toward the shared circuit breaker.
- Add per-agent operation limits, hide tool call details from HTTP responses by default, and validate history limits.
- Limit active sessions per caller in both stores, with atomic PostgreSQL quota checks and explicit 429/503 responses.
- Keep slow request bodies out of execution slots, reject malformed identity scopes, and tighten the legacy HTTP adapter.
- Existing PostgreSQL users must reapply `sql/session-store.sql` for the quota index. The default quota applies to the shared service-key principal unless caller identities are provided.

## 1.5.0 — source release; npm publication pending

- Add an optional application-owned `decide` guard. Only an explicit `true` accepts a structurally valid model choice; rejection clears the executable action.
- Bound guard execution time and pass the named HTTP agent's run identity and abort signal to its server-side guard.
- Keep HTTP callers from supplying a guard, check guard configuration at service startup, and return HTTP 422 for rejected choices without revealing them. Record guard rejection categories without decision content in telemetry.

## 1.4.0 — source release; npm publication pending

- Ask for valid JSON in structured operations. Treat input text as data in prompts and quote criteria and summary focus.
- Require `validate` recommendations to be `pass`, `fail`, or `conditional`; responses missing a recommendation now fail. Check confidence ranges in validation, summary, and decision results.
- Handle OpenAI-compatible tool calls reported with `stop` and return malformed tool arguments to the model without invoking the callback.
- Add a single-run smoke test for a local model, with checks for each operation and tool dispatch.

## 1.3.1 — source release; npm publication pending

- Accept a managed inference key with an explicit gateway URL, and reject accidental use of OpenAI's endpoint.
- Send a request ID and disable automatic retries for managed inference, whose outcome can be ambiguous after a network failure.
- Reject streaming through the managed gateway until it supports streamed accounting.

## 1.3.0 — source release; npm publication pending

### Added

- Stable agent IDs and run IDs in opt-in telemetry.
- Named multi-agent HTTP service with stateless calls, persistent sessions, context and history clearing, and per-agent disable controls.
- Memory and PostgreSQL session stores with renewable leases.

### Fixed

- Allow an explicit `telemetryPath` without changing how existing `telemetryEndpoint` URLs resolve.
- Bound telemetry batches to the ingest contract and retry temporary failures with backoff.
- Flush named-agent service telemetry during graceful shutdown and redact provider errors from its HTTP responses.
- Require server-defined extraction schemas in the named-agent service and pass caller identity to tool callbacks.
- Keep the context character budget after tool results by trimming older chat turns or rejecting an oversized current turn.
- Include `error` in failed `validate` and `decide` results.
- Reject implicit chaining after a failed operation instead of sending a failure or stale result to a model.

## 1.2.0 — 2026-09-23

First source release under the `nullprotocol` package name. It has not been published to npm. `AIToolkit` remains an export alias for migration.

### Added

- OpenAI-compatible base URL for local and lower-cost model providers.
- Local JSON Schema validation for extracted data.
- Context character budget with a sliding window over old chat turns.
- Optional telemetry of request timing and provider token usage.
- `NullProtocol` public export and new README with local, game, and HTTP examples.

### Fixed

- Retry each model request without repeating tool side effects.
- Abort in-flight model requests on timeout.
- Require explicit caller confirmation before protected actions run.
- Reject decisions outside the offered action list and malformed model results.
- Isolate HTTP request state, require server authentication, bind locally by default, and limit body size.
- Remove nonfunctional cloud mode and unused provider implementations.
- Restore clean-install CI with a committed lockfile and package coverage checks.

### Migration

Install `nullprotocol` and update package imports. The old `@stuseek/ai-toolkit` package is not changed by this release. `AI_TOOLKIT_*` environment variables remain accepted for migration; new configurations can use `NULLPROTOCOL_*`.

## 1.0.11 — 2026-01-07

Last published release under `@stuseek/ai-toolkit`.
