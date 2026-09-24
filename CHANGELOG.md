# Changelog

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
