# NullProtocol: product and implementation specification

**Status:** implementation brief, updated 2026-09-28. **Audience:** the coding agent working across the SDK, API, cabinet, and site repositories. The managed API is deployed for one allowlisted team, the cabinet Agent Center is live, and the connected JS SDK is tested on a development branch but not published to npm. This document records founder decisions, implemented behavior, proposed design where a decision is still needed, and deferred work.

## 0. How to use this document

1. Preserve the distinction between **decided**, **proposed**, **current**, and **deferred**. A proposed field or route is not a public contract until implemented, tested, and documented in the owning repository.
2. Implement in vertical slices. A slice includes database migration, API, SDK, cabinet where relevant, failure handling, focused tests, and documentation. Do not build a full UI on stubbed backend data.
3. Do not invent model benchmarks, paid credits, retention promises, availability promises, or hosted deployment capabilities. Mark them pending until measured or implemented.
4. Check the code before modifying each repository. Existing beta routes and keys have real users. Write forward migrations and transition code; never silently reinterpret an old key or agent ID.
5. Keep this specification and the owning repository docs aligned. Update a statement when its implementation or product decision changes; remove obsolete claims.
6. For substantial implementation work, follow the founder's requested loop: implement → local review → Opus 5.5 CLI review → cleanup/fix → tests. Opus feedback is a review, not authority over founder decisions. Never paste secrets or personal data into a review prompt.

### The repositories

| Repository / local directory | Role today | Target responsibility |
| --- | --- | --- |
| `stuseek/nullprotocol`, `/Users/stan/dev/ai-toolkit` | MIT Node SDK `nullprotocol` 2.6.0; local primitives, named HTTP service, metadata telemetry, Space Context client | Connected JS SDK and outbound executor runtime; optional customer-hosted service remains a compatibility/deployment adapter |
| `stuseek/nullprotocol-api`, `/Users/stan/dev/nullprotocol-api` | Heroku API, Neon PostgreSQL, auth integration, teams/Spaces/keys, telemetry, Space Context, runtime control, disabled inference gateway | Source of truth for templates, agents, conversations, managed context/memory, runs, traces, credentials, lifecycle |
| `stuseek/nullprotocol-app`, `/Users/stan/dev/nullprotocol-app` | Deployed cabinet at `app.nullprotocol.ai`, Neon Auth, Radix Themes | Agent Center: templates, agents, conversations, context, actions, runs, traces, controls, team/Space administration |
| `stuseek/nullprotocol-web`, `/Users/stan/dev/nullprotocol-platform` | Deployed landing site at `nullprotocol.ai`; product/mechanics notes | Honest product page and onboarding; claims must track the shipped product |

There is also an older `/Users/stan/dev/ai-toolkit-website`; do not assume it is the production landing. The old NullProtocol project/repositories are not the implementation source for the new product. Do not delete unrelated repositories or customer data while doing this work.

### Current reality, as checked on 2026-09-28

- The SDK package is named `nullprotocol` and is installed from GitHub until npm publication. Its legacy `NullProtocol`/`AIToolkit` primitives and `serveAgents` remain. The managed client and connected executor live on `managed-agents-sdk`: they call the deployed API, support OpenAI-compatible models including local ones, and implement bounded conversation memory and action traces. Legacy local chat history and `maxContextLength` have different semantics.
- The Heroku API runs on Neon PostgreSQL. It hosts Agent Templates and versions, explicit managed Agents, Space keys, connected executor jobs, runs, managed context and memory, conversations, quotas, and audited deletion. It is enabled only for an allowlisted team. Public signup, billing, and managed inference remain disabled.
- The cabinet at `app.nullprotocol.ai` has a separate Agent Center alongside legacy telemetry. Admins can create and manage Agents, inspect content and runs, edit context, and start runs through Ask when an executor is connected. It does not hold model credentials or execute the model.
- Selected Space Context keys are injected into managed runs and refreshed by the executor; existing legacy Space Context callers retain their old behavior.
- Existing team plans are manual entitlements, not paid subscriptions. Team billing, credits, and overage collection are not live.

The API passed a production smoke with the connected JS SDK and a local model, including conversation isolation, selected Space Context, session Ask, access control, and cleanup of disposable data. Agent idle deletion is deployed as an opt-in Template policy. The cabinet is live for the allowlisted team. SDK merge and npm publication, paid plans, hosted execution, and public signup remain separate release gates.

Source documents to check while coding: `README.md`, `docs/agent-model.md` in the SDK; `README.md` in API and app; `docs/product-mechanics.md`, `docs/agent-center.md`, and `docs/benchmark-plan.md` in the landing repository. Older notes predate later founder decisions. This document takes precedence for the **target**, while source code and current READMEs describe the **current deployment**.

## 1. Product in one paragraph

NullProtocol lets a developer create an **Agent Template**, instantiate explicit **Agents**, and call them from a JavaScript SDK or HTTP API. The developer chooses the model, gives the agent instructions and application-owned actions, and supplies live data for each run. NullProtocol manages versioned configuration, bounded execution, Space and Agent context, isolated conversation memory, traces, usage, and controls. The developer can inspect and manage those things in the cabinet. The same primitives should work for a game character, support assistant, incident operator, tutor, CI reviewer, data workflow, or other application. The agent is a durable identity and state record, not a permanently running process.

### Product boundary decided by the founder

- **Connected only for the new managed-agent model.** Drop the fully local, accountless agent product direction. Creating/managing a Template, Agent, managed context, memory, or run requires a NullProtocol Team/Space and an authorized project credential. This supersedes earlier product notes that positioned standalone execution as the main free tier.
- **Free means free hosted control/state tier with the developer's provider key or local/self-hosted model**, not an autonomous library that never talks to NullProtocol. Local LLM support remains: the model endpoint can run on the developer's network, while configuration and managed state connect to NullProtocol. Explain clearly that an offline local LLM is compatible but an offline NullProtocol platform is not the normal managed mode.
- The initially supported developer surfaces are **JavaScript SDK and HTTP API**. CLI, Python, Unreal Engine, and other SDKs are later. Both initial surfaces require a developer credential. A secret Space key stays on a trusted server/runtime, never in a browser bundle or shipped game client.
- The old low-level primitives may need a compatibility window for existing installations; they are **not** a second fully local product to build out. Decide and announce breaking behavior in a major release. Do not make existing 2.6.0 consumers suddenly send their data to the platform through a minor update.
- The user application owns business data, rules, authorization of its own users, event sources, and action implementations. NullProtocol owns the generic agent machinery and managed state. Generic `search` does not know a merchant's catalog: the merchant registers `searchCatalog` and checks permissions in its handler.

### What the customer gets

1. One place to create a reusable agent design, instantiate agents, see exactly what they know, and change allowed behavior without hunting through each application process.
2. A bounded path from input and context to model choice, schema-checked actions, application guards, and recorded outcomes. Validation can reject malformed output; it cannot guarantee a fact or decision is correct.
3. Useful memory under a strict budget: recent turns, exact extracted facts with provenance, and a compact summary, isolated per conversation key.
4. A clear runtime boundary. One process can serve many agents; an idle Agent record costs no dedicated process. Teams can use their own model keys, a local model endpoint, or later managed model credits.
5. A dashboard that shows configuration, context, memory, actions, versions, run steps, cost/usage, and deletion state. Content visibility and retention must be explicit.

## 2. Terminology and ownership

| Term | Definition | Owner/scope | Important constraint |
| --- | --- | --- | --- |
| Team | Billing and membership boundary | Organization | Cloud/Team subscription and credits cover all its Spaces |
| Space | Project/state/credential boundary | Team | Separate Space recommended for production and staging; environment labels alone do not isolate state |
| Agent Template | Versioned reusable behavioral configuration | Space | Contains model selection, instructions, action contracts, and policies; a later schema may add a built-in Role preset; contains no executable action code |
| Template version | Immutable published snapshot | Template | Runs record the effective version; existing Agents pin by default |
| Agent | Explicit durable instance of a Template | Space | Stable ID, Template association, name/avatar, own context and optional shared Agent memory; not a process |
| Conversation | One isolated history under an Agent | Space + Agent + caller-supplied conversation identifier | Created lazily on first run; recent window, facts, summary and linked runs are isolated |
| Run | One invocation of an Agent | Agent + optional Conversation | Has stable run ID, status, versions, usage, trace, and idempotency identity |
| Runtime instance | One application process or customer-hosted service that executes model calls/actions | Space, with ephemeral instance ID | May host many Agents; online status requires heartbeat, not a recent event |
| Action | Named schema contract in a Template, implementation in the developer SDK runtime | Template/Agent allowlist + runtime | Model chooses from allowed names; handler enforces business rules and authorization |
| Run context | Fresh caller-supplied facts for one run | Run | Not automatically durable memory |
| Agent context | Durable current working facts for one Agent | Agent | Keyed/identified, replaceable and deletable; not conversation history |
| Space Context | Shared current facts for all Agents in a Space | Space | Reads latest version before subsequent model decisions/actions |
| Memory | Recent turns, extracted facts, compact narrative, confirmed action outcomes | Conversation by default; Agent-wide only through explicit trusted write | Derived facts need provenance and invalidation |
| Trace | Record of a run's decisions, model/tool steps and outcomes | Run | Inspection record, not automatically pasted into future prompts |
| Role | Optional built-in instruction preset, after its registry is defined | Future Template version | Distinct from Template identity and name; omitted from config schema v1 |

Do not use “Agent” to mean a session, a conversation, a process, or a one-off model request. Avoid introducing `Replicant`, `Class`, `Prototype`, or other second names for Agent Template. Use `conversation` as the proposed public API name for keyed history; migration adapters can accept old `sessionId` where relevant, but public examples should have one term.

### Core invariants

1. Unknown Agent ID is an error; invoking an ID never silently creates a new Agent. Creating a Template also does not create an Agent.
2. Only an explicit create call in the SDK/API or cabinet creates an Agent. It appears in the cabinet immediately. A batch create operation may create many explicit Agents.
3. An Agent's Template ID is immutable. Its effective Template version is pinned unless its separately chosen update policy allows adoption. A run records the effective version.
4. Different conversation identifiers never share automatically extracted facts, summaries, recent chat turns, or conversation-specific trace content. Agent-wide state is shared only by explicit trusted writes.
5. A model has no raw SDK/admin API access. The model can request only registered actions visible in its current manifest. A handler is trusted code and must enforce application rules.
6. In managed runs, the latest committed versions of the **Space Context documents selected by the Template** are read before each new model step and before each write action. A model request already in flight cannot retroactively change. Legacy explicit Space Context access keeps its old behavior.
7. Deleting a conversation or Agent must remove its managed content and linked trace content, not merely hide rows. Backups need a disclosed lifecycle and must never be presented as live searchable content.
8. Agent pause, stop, deletion, disconnected runtime, and model/provider errors have distinct visible states. Do not claim that a cancelled side effect was rolled back.

## 3. Product plans and limits

The founder's draft: **Free**, **Cloud $15/month**, and **Team $30/month**. Subscription and included credits belong to a Team and apply across its Spaces. Team includes **three seats including the owner**. Cloud and Team may use NullProtocol-managed model access plus telemetry; usage above included credits was discussed as **2× the configured provider rates**. Included credit quantities and retention windows were **not** decided. No payment provider is connected. Treat pricing as a product direction, not a billing entitlement until payment collection, provider cost reconciliation, usage displays, downgrade behavior, and refunds are implemented and tested.

Target Free constraints discussed: **one Space and three managed Agents**, developer-supplied model key or local model, connected state and basic telemetry. A Free Team cannot have a separate staging Space under that cap; use one Space and test carefully or upgrade. Existing beta database limits differ; do not tighten existing accounts silently. The proposed managed-Agent quota counts non-deleted `managed_agents` only; telemetry-discovered identities retain their existing separate quota and control behavior. Archived managed Agents count until hard deletion, so archiving cannot evade the cap. A single Agent can serve many conversations, so three Agents is not three end users. Limit conversations, runs, state storage and model spend separately so a customer cannot create unbounded histories through one Agent. Avoid choosing exact values by intuition; measure realistic workloads and publish limits in the cabinet/API.

The paid tiers should be understandable without hiding implementation mechanics:

- **Free:** core connected Agent Template/Agent/Conversation workflow, own model/local model, small team and Agent allowance, basic visible history/context/runs with bounded retention.
- **Cloud $15:** managed model credentials/credits once available, greater useful capacity, standard telemetry. Own-key use must remain possible.
- **Team $30:** Cloud plus advanced traces/telemetry and three team seats; Space sharing through Team membership. Seat enforcement already exists in beta but payment does not.
- **Enterprise, later:** customer-managed deployment/storage/network controls and contractual requirements. Do not imply this is available today.

Model costs and product subscription are separate ledgers. The managed gateway currently has internal test credit and a 2× quote calculation, but it is disabled in production and lacks provider invoice reconciliation. Do not convert its test ledger into real billing by enabling a flag alone.

## 4. Desired architecture

```text
Developer's application / customer runtime
  ├─ JS SDK caller and/or connected executor process
  ├─ model provider key or local OpenAI-compatible model endpoint
  ├─ registered action handlers, app data and app authorization
  └─ NullProtocol Space credential (server-side only)
                  │
                  ▼
NullProtocol API (api.nullprotocol.ai) + Neon PostgreSQL
  ├─ Team / Space / credentials / membership
  ├─ Template versions / Agents / controls
  ├─ Space + Agent context / conversation memory
  ├─ HTTP run creation, bounded dispatch queue / traces / usage / lifecycle
  └─ optional managed model gateway, when paid launch is ready
                  │
                  ▼
Cabinet (app.nullprotocol.ai)
  ├─ create/configure Template and Agent
  ├─ inspect context, conversations, actions, traces
  ├─ pause/stop/delete and manage keys
  └─ see plan, quota, usage and Team membership
```

**Decided first execution topology:** `api.nullprotocol.ai` is the first-release HTTP run entry point. It accepts a run request from a trusted application server, checks credentials, Agent state, idempotency and availability, persists the run, and dispatches it to a **connected outbound SDK executor**. That executor runs the model loop and application action handlers in the developer's trusted environment, then sends bounded steps and state commits back to the platform. It can reach a private local LLM without opening the developer's network to inbound platform traffic. One executor process serves many Agents. It is not a microservice per Agent. The JS SDK `agent.run()` submits to this same platform endpoint and awaits/polls/streams the result; it does not create a second, inconsistent execution path. `extract`, `validate`, `summarize`, and `decide` are internal managed-run step kinds visible in traces. They remain public only on the legacy primitive client during migration.

An executor must establish an authenticated outbound job channel before the API accepts runs for an Agent. A bounded long-poll protocol backed by PostgreSQL can be the simplest first transport; WebSocket is optional if it materially improves latency/streaming. Separate the existing control heartbeat from job delivery or extend it with an explicit versioned protocol. On proposed `POST /v1/spaces/:space/managed-agents/:id/runs`, the API either reserves an available compatible executor and returns a `runId`, or rejects with `runtime_offline`/`action_unavailable`/capacity error **without creating an unexecutable run**. The accepted run is dispatched with a short lease; the executor presents that lease when reading scoped state or appending steps. Unclaimed jobs can be retried safely. A job that started a write action is never blindly redelivered after an ambiguous disconnect. The API exposes run status and event stream so non-JS callers can poll or subscribe; `POST` may return `202` with a run ID rather than holding a long HTTP request open.

If a Template uses no customer-hosted actions and a provider reachable from the platform, a hosted executor is possible later. In v1 even such Agents need a connected executor; this keeps one execution protocol and supports BYOK and local models. The cabinet may offer “Ask this Agent” once this API path, permissions and executor availability work. A local model or private handler cannot run merely because the Agent record exists in the cloud.

**Availability policy, proposed:** managed runs require a compatible connected executor and authorized access to state before execution. If the executor is offline, the platform cannot supply fresh required config/Space Context, or the conversation is busy, reject clearly and do not run from stale state. If a run already started, finish or cancel according to the run lease protocol and show `unknown` where a side effect's outcome cannot be confirmed. The old local primitives may behave differently during their migration window; they are not the target guarantee.

## 5. Creation and lifecycle flows

### First-time onboarding

1. User signs into the cabinet. When public signup opens, provision a personal Team with a `Default Space`; the current production signup gate remains closed until its existing email and grant work is complete.
2. Show “Create your first Agent” as a practical path. Offer example **Template starting points** such as chatbot, game character, DevOps/operator, or general assistant. These are editable presets, not different runtime classes.
3. Choose model/provider or local endpoint path. Free users attach their own provider credential in the trusted runtime; they may use a local model. Do not ask them to send an unencrypted provider key in a template payload. If cabinet-managed provider credentials are added, encrypt and scope them separately and make data flow explicit.
4. Define a Template: name, instructions, model reference, allowed action contracts, context/memory policy. Publish version 1. Built-in Role presets need a registry and are deferred; a role field is not silently accepted by config schema v1.
5. Explicitly create an Agent from that Template. Assign optional display name and generated avatar. Generated names/avatars are cosmetic; regenerate only on explicit request. Avoid a default Agent per end user.
6. Issue/show the Space credential once, plus code to load and run that Agent. The dashboard shows the newly created Agent before its first run and labels it idle/offline rather than “running.”

### Agent creation from code

`templates.create` and `agents.create` are separate explicit calls. The code path should be idempotent under deployment retries, so the caller can supply an idempotency key or stable external ID. Creating the same resource with conflicting content must return a conflict rather than silently mutate it. A `createMany` endpoint is useful for game NPCs or bulk jobs, but each created Agent counts against the Agent quota. Unknown `loadAgent(id)`/`agent(id)` cannot create it.

### Template versions and adoption

Editing behavior produces a new immutable Template version. The cabinet and SDK can each propose edits against an `ifVersion`/ETag; unrelated fields must not be lost. New Agents use the latest published version. Existing Agents remain pinned by default. An explicit Agent policy may follow future versions; automatic adoption is off initially. If a future version removes or changes an action, surface compatibility before publishing/adopting. Record version and effective action manifest on every run. Rollback is a new explicit pin to an earlier version or a new published version, not in-place rewriting of historical versions. A Template referenced by any non-deleted Agent may be archived to block new instantiation but cannot be hard-deleted.

### Agent identity and control

An Agent differs from its siblings mainly through ID, optional display name/avatar, Agent context/memory, conversation histories, and lifecycle state. Model, instructions, ordinary action allowlist, budgets and defaults belong to its Template. The cabinet can disable an action on a specific Agent as a narrow safety override; it cannot redefine the handler or widen the Template allowlist. Keep this override explicit in the effective run manifest.

Agent states: `active`, `paused`, `stopping`, `deleting`, `deleted`; connection state is separate (`online`, `offline`, `unknown`) and applies to runtime instances. Pause blocks new runs and lets active runs finish. Stop also requests cooperative cancellation. Deletion blocks new runs immediately, cancels active work when possible, then purges Agent data. Offline runtimes cannot acknowledge a stop immediately; cabinet shows pending/applied counts. Existing beta runtime-control polling can be migrated rather than replaced blindly.

**Hard delete decided:** an Agent deletion removes its own context, Agent memory, conversations, linked run content/traces, and configuration overrides. It does not delete its Template or the Space Context. Proposal: never reuse an Agent ID within a Space after hard delete, to prevent a stale caller from reaching a new identity; confirm before making this a permanent public guarantee.

### Idle deletion

V1 has one optional policy in the immutable Template version: `retention.agentIdleDays` is `null` (off, the default) or `30`. An Agent with the policy is deleted with all its context, memory, conversations and linked runs after 30 days without a run across any key. New Agents count from creation; a newly adopted retention policy counts from adoption, so an old Agent cannot disappear immediately. Every newly created run extends the deadline. Paused Agents still count as idle; runtime heartbeats, context edits and cabinet views do not reset the clock. The API exposes `expiresAt`, the cabinet shows the date and warns on enabling or pausing, and the purge is audited with reason `idle`. Neon backups have separate retention. Per-conversation idle deletion remains a later option; for now histories persist until their Agent or the specific conversation is explicitly deleted.

## 6. Conversation model: one Agent, many histories

A reusable support Agent may serve thousands of customers; creating one Agent per customer is usually wasteful. The application passes an opaque `conversation` identifier such as `ticket:456` or `player:opaque-id:merchant`. On first run for that identifier, NullProtocol creates its managed history lazily under `(Space, Agent, conversation)`. Every such history has its own recent window, precise facts, summary, brief action outcomes, version, and linked runs. Another conversation cannot read it through normal Agent memory assembly. A distinct Agent per customer is still valid when identity, configuration, control, or long-lived Agent-level context truly differs.

The application chooses conversation boundaries. Chat UI thread, support ticket, game interaction, workflow job, and incident are possible boundaries. A `conversation` is not necessarily an authenticated end user; a ticket can have a customer and several staff participants. Avoid hardcoding a single owner in storage. The app must authorize who may call a given conversation. A key string is an address, not proof of permission. Never expose a secret Space key to an untrusted client, or let that client submit arbitrary conversation IDs with that key.

**Proposed public name and shape:** `conversation` is the parameter; internally store an opaque stable ID plus a separately indexed/external identifier, bounded and normalized. Recommend opaque, non-PII strings in examples. A display label can be separate. Scope lookup by Space and Agent as well as conversation; a matching string in another Agent or Space is a different history. Define collision, normalization, length, and character handling in one API contract. Hash external identifiers where feasible, but preserve the ability to inspect them if product requirements demand it; do not promise anonymity if the key itself contains personal data.

For a chatbot, send the latest message as `input` and use the conversation history. Live order status, stock, permissions, or game position should arrive as **run context** fetched by the application. Do not promote changing business facts into durable Agent memory automatically. Automatic extraction remains inside the conversation. Writing to Agent-wide context or memory is an explicit trusted SDK/API operation, not a side effect of ordinary chat.

### Simultaneous requests

**Proposed v1:** one writer per `(Space, Agent, conversation)`, using a database-backed lease or transaction protocol. Different conversations run in parallel. Start with an explicit `conversation_busy` response; bounded queueing can be added after measured need. A busy rejection creates no run record and does not consume the idempotency key. A lease loss cancels the run before narrative memory commit. Confirmed/unknown action outcomes already appended to the step log remain available for the next run. Compaction and extraction either use the same per-conversation serialization or compare-and-swap the version and recompute on conflict. Agent Context and Space Context writes have their own version checks.

The old self-hosted `serveAgents` already has a session lease and a `session_busy` error. Reuse its tested parts where they fit, but do not confuse its principal-scoped session UUID with the new globally managed Agent conversation identifier.

### Retries and idempotency

**Proposed v1:** accept a caller-provided `idempotencyKey` for runs, scoped to `(Space, Agent, conversation or stateless sentinel)`. A retry with the same key and same canonical request refers to the same run; a different payload is a conflict. Specify retention and what happens when the original run is still active, succeeded, failed, or has unknown outcome. The API must not silently start a new run for a network retry. An action call gets a stable `runId` and `callId`; the SDK supplies a stable action idempotency identity on redelivery. Handlers with side effects must deduplicate in the application's data store and forward the key to downstream APIs where supported. The model can call the same write action twice within one run with different call IDs; domain rules in the handler still need to prevent duplicate business effects.

If a write action times out after dispatch, record its outcome as `unknown`; do not automatically repeat it as if it failed. Read-only actions may be retried under bounded policy. A cancelled run may already have caused a side effect, and the trace must say so. The existing SDK's `callId` identifies one tool attempt within a run; its current README explicitly says it is **not** a cross-run idempotency key. Do not misrepresent that behavior during migration.

## 7. Context and memory

### Five stores, five jobs

| Layer | Inserted by | Lifetime | Example | Access path, proposed |
| --- | --- | --- | --- | --- |
| Run context | Trusted application on invocation | This run | Current order state, user message, logs just fetched | `run({ context })` |
| Space Context | Application SDK/API or cabinet editor | Until replace/delete/TTL | Common incident playbook version, world state shared across agents | `space.context.get/put/delete` |
| Agent Context | Application SDK/API or cabinet editor | Until replace/delete/TTL | Mira's current shop policy or one operator's assigned system | `agent.context.get/put/delete` |
| Conversation Memory | Automatic bounded history, facts, summaries and outcomes | Until explicit deletion or Agent idle deletion | Ticket-specific preferences and prior exchanges | `agent.conversations.get/list/delete` plus run assembly |
| Agent-wide Memory | Explicit trusted SDK/API writes; no automatic cross-conversation promotion | Until deletion | Stable facts intentionally shared by every conversation | `agent.memory.add/remove/list` |

`context.add` and `memory.add` must be separate operations. Context is **current working data**, often replaceable. Memory is **what should carry forward**, especially facts with provenance and a summary of history. Both use stable entry IDs or keys and versioned updates. A run may use no conversation, or a Template may disable conversation memory for stateless tasks. A stateless call may still read Space and Agent Context.

### Space Context semantics

Space Context belongs to the Space, not to an Agent. It is keyed and visible/editable in the cabinet. The application can get, set and delete entries; the existing API already has versioned `get/put/delete` and a separate context credential. In the managed model, Agents automatically include the appropriate Space Context entries before model work. Which entries are “appropriate” needs an explicit selection policy so one giant Space does not fill every prompt. Proposal: Template declares selected namespaces/keys or a bounded selector; v1 can start with selected keys only. Avoid silently injecting all stored documents. The cabinet must show the effective selection and size.

All Agents in a Space should see a committed update before their **next** model decision or external action that depends on Space Context. A prompt already sent to a provider cannot be changed retroactively. For multi-step runs, read/check the version before each such step. Record the version and selected key revisions in the trace. If a selected required key cannot be read, fail that step rather than use unknown stale data. If the key was deleted, apply the Template's explicit absent-key policy or fail; never invent a value.

The model cannot directly call `space.context` SDK methods. An integrator may register an action whose handler writes to any allowed Space Context key. Such writes are possible only through that declared action and its guard/schema. A generic bulk clear/delete action is **not** registered by default and requires a separate explicit action. If a model-accessible write occurs, record the before/after versions and affected keys, but avoid logging secret values. The founder chose to allow broad writes if the integrator explicitly exposes them; do not impose an unconditional product ban that reverses that choice.

### Agent Context semantics

Agent Context is current state for that one Agent, independent of any one conversation. It can be edited through code and cabinet by stable key/ID, with compare-and-swap versioning and audit attribution. Templates define context policy, not per-Agent behavior overrides. Large domain datasets belong in the application; an action may query them and return a bounded result. Never copy the whole catalog into Agent Context simply because a model may need search.

### Conversation memory algorithm

Use a **sliding window** of recent exchanges plus **precise extracted facts** and a **short summary** of the rest. Extraction should preserve exact data that may matter later: IDs, numeric values, units, dates, names, explicit preferences, commitments, and confirmed action outcomes. Store source run/message IDs and extraction version for every fact. Summarize less exact narrative separately. Do not flatten a precise order number or date into an ambiguous paragraph. Record actual action outcomes concisely, distinguishing `success`, `failure`, and `unknown`; a requested action is not evidence that it happened.

Compaction triggers when projected prompt size approaches the configured context budget, not on every message by default. It uses the Template's selected model in the first release; no automatic “cheap summarizer model” yet. Preserve the recent window while older turns are compacted. Commit facts/summary atomically against the conversation version. A failed extraction or compaction leaves the previous committed memory intact and the run must handle budget pressure explicitly. The dashboard shows when and why compaction happened, source spans, token/character counts, selected model, and any error.

When a generated fact or source message is deleted, invalidate every derived summary/retrieval entry that contains it **in the same transaction**; invalidated content is excluded from future prompt assembly immediately. The customer runtime may regenerate it from retained source during the next connected run and record a compaction step. The platform does not call a local/customer model by itself to rebuild memory in v1. Deleting a whole conversation purges all its derived content. Generated facts and summaries should not be edited in place in the cabinet because provenance would become false. Explicit Agent-wide `memory.add` is available to trusted application code, not a default model ability. An integrator can deliberately register a memory-write action; it must be bounded, attributed and scoped, and it should not write from one conversation into Agent-wide state casually. The dashboard reads/removes but does not manually insert memory entries under the current decision.

### Prompt assembly and budgets

Assemble a model request from ordered, bounded components: Template instructions (and a built-in Role preset after its registry ships); selected current Space Context; Agent Context; trusted run context; conversation facts/summary; recent window; current input; and action contracts. Label each source and keep application data distinct from instructions. Treat tool results and user content as untrusted data, even if wrapped in JSON. Never allow a tool result to rewrite system instructions or action permissions.

The default budget must be tuned on actual supported models and tasks, then configurable in the Template. Advanced users may set total context limit, reserve for model output/tools, recent-window target, fact budget, summary budget, compaction threshold, max tool-result size, and max steps. Avoid exposing a confusing swarm of sliders in the basic UI; show sensible presets and an advanced panel. Count with a model-aware tokenizer when available, with an honest conservative estimate otherwise. A hard provider context error is surfaced and traced. Required instructions/current input/action schemas never disappear silently; if they alone exceed the budget, fail with a clear error. When content must be dropped, show what category was reduced. The old SDK's `maxContextLength` counts characters and drops oldest local history; it is a migration input, not proof that the managed policy is done.

### Large external data

An app action such as `checkLogs` or `searchCatalog` may return many records. Default behavior: reject an oversized result before another model call. An explicit Template/action policy may batch the result, extract signals, and summarize batches with bounded size and recorded provenance. The processed result enters the **current run** only. It does not become durable memory unless the ordinary memory rules later select verified information. Keep the original large payload in the application or a bounded trace store according to retention settings; do not dump arbitrary megabytes into PostgreSQL rows or prompts. Validate structure before extraction and bound nested depth, strings, count, and total bytes.

## 8. Model providers and execution

Each Template version stores one **nonsecret model reference**, for example `{ provider, model, credentialRef }`. Agents created from that Template share it unless a new Template version changes it. The connected runtime maps `credentialRef` to a local secret and base URL; one runtime can map several references for different Agents/providers. If a required reference is missing or its endpoint unavailable, fail with `model_unavailable` before model work. Different Templates/Agents in one Space can use Mistral, OpenAI, Anthropic, compatible hosted APIs, or a local OpenAI-compatible endpoint. A raw “smartness” slider is a possible UI shortcut later; it must map to an explicit model/version and disclose price/availability. It is not the model of record.

For the first managed release, one chosen model handles normal turns, `extract`, `validate`, `summarize`, `decide`, and compaction. Separate task-specific model routing is later. Provider credentials are separate from Template JSON. Developer-owned provider keys stay in the trusted runtime for BYOK/local mode; managed gateway keys stay on NullProtocol when paid model access is live. Secrets never appear in traces, telemetry, browser payloads, runtime manifest, or dashboard reads. Rotate credentials without creating a new Template version if model behavior did not change; record a nonsecret credential reference/version for audit.

The runtime needs a provider adapter contract for structured output, tool calls, streaming, usage reporting, timeouts and cancellation. Capability differences must be explicit. A model that cannot reliably supply tool calls should have a supported fallback protocol or be marked incompatible with action-heavy Templates. Retries must be bounded and distinguish transport failure from schema failure. Do not claim that retries or output validation fix wrong decisions. An application guard remains the final authority on hard rules.

The NullProtocol managed inference gateway exists in staging form but is disabled in production. It supports nonstreaming text/function calls and stores billing metadata, not prompt content. It is independent of the new managed state/traces and should not be activated for paid users until cost accounting, reconciliation, credit controls, and payment integration are ready. A developer using BYOK can still use the managed Agent Center without buying model access if the plan permits it.

## 9. Actions and decisions

### Contract

An action has stable name, plain-language description, JSON Schema input, JSON Schema output, read/write classification, optional timeout, and result size bound. The immutable **Template version is authoritative for this contract**. The customer runtime registers the matching executable handler and declares the contract hash it implements; it may restate schemas locally only for a hash check, not to silently redefine the Template. The cabinet shows contracts and whether the Template and current Agent allow them; it cannot upload code. A per-Agent disable override can narrow availability. Every Template-allowed action that is not disabled for this Agent must have a registered handler with a matching contract hash before the run's first model call. Otherwise reject with `action_unavailable`. There is no silent intersection that makes a missing action disappear from the model's list.

The model receives names, descriptions, and input schema, not code or credentials. Validate the model's action name and arguments locally against the effective manifest. The handler validates application permissions and real-world preconditions using trusted state. Validate the handler's output against its output schema. Store bounded arguments/results in traces only according to the content policy, with secret redaction before upload. The model cannot grant itself another action or edit its own Template.

### Example: incident operator

An hourly scheduler belongs to the application or later NullProtocol scheduling feature. It starts a run and supplies fresh monitor state. The Agent can call `checkLogs` to read a bounded batch; the generic extraction path identifies error patterns and precise counts; the run summarizes the incident; `decide` selects from permitted actions; an application guard checks trusted metrics; a write handler such as `restartService` verifies service identity and policy, uses an idempotency key, and reports a confirmed or unknown outcome. The trace shows `check logs → extract signals → summarize → decide → guard → action outcome`. “Identify the problem” and “make a decision” do not need two separate vague model stages if one decision contains the diagnosis and chosen action.

### Safety and approval

Allowlist and JSON Schema checks prevent unsupported names or malformed parameters; they do not prove the chosen action is wise. Preserve application-owned guards. For destructive actions, integrators may require application approval before execution. The initial managed run can be bounded and synchronous; durable pause/resume across a human approval is deferred. An application can collect approval externally and start a new run with the result. Never report an action as completed when it was merely selected or awaiting approval.

The model may call a registered action that writes Space Context or conversation memory only if the developer explicitly exposes it. Model-initiated Agent creation is deferred. There is no built-in catalog search, webhook, cron, or inter-agent messaging that bypasses the application's rules. These are possible integration mechanisms, not core magic.

## 10. Run protocol and states

The run is the unit of execution, visibility, cost and retry. The platform API accepts the run request, checks for a compatible online executor, and creates/dispatches the run. The executor claims it before model work and receives the effective Template version, Agent state, selected Space/Agent Context revisions, a `runId`, a lease token, the conversation's immutable **incarnation ID**, and its state version. Then it sends bounded steps and commits the final conversation/memory change. Every step/commit write must match the active run, live lease, incarnation ID and expected state version. Recreating a conversation under the same external string generates a new incarnation ID, so a late commit from the deleted history can never populate the new one. A general run-submission permission alone must not write memory outside an active executor lease. The API must reject a stale Agent, disabled action manifest, expired lease, revoked key, deleted conversation, or over-budget run in a typed way. A run remains visible if the runtime disappears; after lease expiry, mark it interrupted/unknown rather than inventing success.

Proposed state machine:

```text
accepted → dispatched → running → completing → succeeded
                              ├────────────→ failed
                              ├────────────→ cancelled
                              └────────────→ unknown/interrupted
```

`waiting_for_lease` is reserved for a future bounded queue; in v1 a busy conversation rejects before creating a run. `failed` means execution stopped with a known error. `cancelled` means cancellation was accepted; it does not mean previous side effects were reversed. `unknown` means the platform cannot determine the final outcome, especially after a runtime or network loss during a write. Do not make `unknown` automatically eligible for retry. Record timestamps, trigger source, request identity, effective config versions, selected context revisions, model/provider label, action manifest hash, and usage information on the run. Append action starts and outcomes to a durable step log as they happen, independent of the final narrative-memory commit. The next run in that conversation must include unreconciled `started`/`unknown` write-action outcomes from interrupted runs so the model does not assume they never happened.

Limit steps and time per run, including model requests, action calls, compaction, and retries. Define explicit bounds for streaming, total input bytes, action result bytes, trace bytes, and open connections. A timeout needs a distinct error from a bad answer. The runtime should heed abort signals before starting each model/action step. A stop command is eventually applied by connected runtimes; an already started action may finish.

### Streaming

The platform run-status/event API and JS SDK should expose one event schema for `run.started`, model text deltas, action requested/started/completed/failed/unknown, context refresh, compaction, usage, and terminal state. A caller may `POST` and poll `GET`, or subscribe to a platform event stream. The executor uploads ordered bounded events; the platform fans them out without assuming that the caller stays connected. Consumers must not mistake a partial text stream for a committed Agent memory update. A stream that is abandoned or whose client disconnects follows a documented cancellation policy; its stored run can still show started side effects. The existing SDK streaming `chat` has materially different behavior, including no tool execution in its raw stream path. Do not reuse that path unchanged and claim parity with managed runs.

### Proposed API error codes

| Error | Meaning | Caller behavior |
| --- | --- | --- |
| `agent_not_found` | Explicit Agent does not exist in Space | Create Agent explicitly or correct ID |
| `template_version_conflict` | Edit/update based on stale version | Reload and resolve |
| `agent_paused` / `agent_deleting` | New run is disallowed | Do not retry until state changes |
| `runtime_offline` | No compatible connected executor can serve the Agent | Reconnect runtime; no pretend success |
| `action_unavailable` | Template and runtime action manifests disagree | Fix deployment/configuration |
| `conversation_busy` | Another run owns that conversation; no run or idempotency reservation was created | Retry with the same request identity after delay |
| `conversation_deleted` | A late step/commit targeted a deleted or recreated incarnation | Stop writing; do not recreate content |
| `idempotency_conflict` | Same key, different request | Generate a new key only for a genuinely new operation |
| `context_conflict` | Versioned write lost a race | Reload and merge |
| `context_budget_exceeded` | Required prompt parts cannot fit | Shorten inputs or change policy/model |
| `model_unavailable` | Provider/local model cannot be reached | Retry only under documented policy |
| `run_outcome_unknown` | Side effect or run outcome cannot be proven | Reconcile with application, do not blindly repeat |
| `quota_exceeded` | Published Space/Team limit hit | Inspect limit and plan |

HTTP status codes and response envelope need one central contract shared by SDK/API/runtime. Errors sent to external callers must omit raw provider failures and internal secrets; traces may contain bounded safe diagnostics. Attach `runId` where one exists.

## 11. Credential and authorization model

The developer first initializes the JS SDK or calls the HTTP API with a **NullProtocol project credential**. For target managed state, it identifies and authorizes a Space. It is distinct from an OpenAI/Mistral/Anthropic provider key, a human dashboard session, and the current telemetry/runtime/context keys. This developer credential grants capabilities to trusted application code, not to every end user of that application.

**Recommended v1:** issue Space-scoped server keys with narrow scopes such as `templates:write`, `agents:write`, `runs:create`, `runs:read`, `context:read/write`, `conversations:read/delete`, `runtime:connect`, and `runs:execute`; use separate keys for application callers, executor processes and administrator scripts by default. `runs:create` submits runs but cannot read arbitrary stored conversations. `runtime:connect` registers an executor instance/manifest, heartbeats and receives control revisions; it grants no run content. `runs:execute` is an executor-only lease-bound capability: claim a dispatched run, read only its assembled context/memory, append steps and commit it. It does not grant arbitrary conversation listing or content reads. An explicit management read scope is separate. A trusted executor normally needs both `runtime:connect` and `runs:execute`; an application caller normally needs `runs:create` and optionally `runs:read`. Store only key hashes, show a new key once, support rotation/revocation, and audit issuance. Existing `np_ingest_`, runtime, context and `np_inf_` keys keep their old permissions while migration proceeds; never silently broaden them into a universal managed-agent secret. Design SDK initialization to accept a `spaceKey` and discover its Space without copying a Space ID into every call. If an HTTP path also contains `:space`, a mismatch with the key's Space returns 404.

The application authenticates its player/customer/operator and chooses the conversation identifier. It can pass a `subject` claim (opaque end-user/tenant ID) for trace attribution and handler guards, but NullProtocol cannot verify that claim independently when it comes from a trusted Space key. Therefore authorization of end-user access remains in the application. The application must not forward a client-chosen arbitrary conversation ID without checking it. Every model-requested action handler must check the trusted `subject`/application session and current domain state, not treat model-produced `customerId`, `orderId`, or file path as authorization.

**Browser/game client direct calls are deferred.** Later, an application server may mint a short-lived restricted client token tied to one Agent, one exact conversation, an authenticated subject, allowed action subset, and budget. The client never sees the Space secret. Origin/CORS checks are extra controls, not identity. A direct browser API without a token issuer is a different anonymous/public-agent product with abuse and billing risks; do not slip it into v1 under the name “HTTP API.” The first HTTP run API is **server-to-server at `api.nullprotocol.ai`**, using the developer's Space credential; the platform dispatches to the connected executor.

For human cabinet access, reuse existing Team membership and Neon Auth. Define separate privileges for creating Templates/Agents, managing credentials, deleting content, and viewing conversation/trace **content**. Metadata/usage visibility need not imply the right to read customer messages. Audit reads and deletes of sensitive content with actor, Space, Agent/conversation, time and reason/source. Mask provider keys and known secret fields. A Team seat grants a human login; it is not an Agent, runtime, or conversation quota.

## 12. Persistence and data contracts

Neon PostgreSQL is already the API's database. Start there. Do not introduce a second analytics database for pre-launch traffic without measured need. Keep high-volume immutable events separate from hot conversation state. Use indexes and retention/partitioning when evidence warrants. Make migrations reversible where feasible, and always safe to rerun. The current API has tables for `teams`, `spaces`, `agents` (telemetry-discovered identities), `events`, `space_context_documents`, `runtime_instances`, controls, and inference ledger. Their semantics do **not** equal all new entities; migration must distinguish discovered Agent rows from explicitly created managed Agents.

### Proposed logical schema, not exact SQL

| Entity | Key fields | Constraints/notes |
| --- | --- | --- |
| `agent_templates` | `id`, `space_id`, `name`, `latest_version`, timestamps, archived/deleted state | Unique stable ID in Space; ownership and quota checks |
| `agent_template_versions` | `template_id`, `version`, config JSON, schema version, creator, published time, content hash | Immutable after publish; validate all referenced actions/policies |
| `managed_agents` | `id`, `space_id`, `template_id`, `pinned_version`, adoption policy, display name/avatar ref, lifecycle state, timestamps | Explicit creation; distinguish from telemetry discovery; immutable Template ID |
| `agent_action_overrides` | Agent/action, disabled flag, revision, actor | May narrow Template permissions only |
| `agent_context_entries` | Agent/key or ID, JSON value/ref, version, expiry, creator/updater | CAS writes; bound total size |
| `agent_memory_entries` | Agent/ID, content, source/provenance, version, deletion state | Explicit trusted writes only in v1; cannot silently inherit conversation facts |
| `managed_conversations` | `space_id`, `agent_id`, opaque external key/index, immutable incarnation ID, version, status, last-run/expiry | Unique live row by scoped key; recreation after deletion gets new incarnation; soft state only during purge |
| `conversation_messages` | Conversation, run, order, role, bounded content/ref, timestamp | Retention and deletion provenance |
| `conversation_facts` | Conversation, stable fact ID, exact value, source IDs, extraction model/version, state | Deletion invalidates derived summary/index |
| `conversation_summaries` | Conversation/version, content, source range, model/version, created time | Rebuildable from retained sources; never cross key |
| `managed_runs` | Run ID, Agent, conversation nullable, idempotency fingerprint, status, versions, timestamps, usage | Scoped idempotency; terminal state immutable except reconciled `unknown` transition with audit |
| `run_dispatch_jobs` | Run, assigned instance/lease, claim/deadline, delivery attempt, state | Bounded durable outbound job queue; distinguish unclaimed from potentially side-effecting work |
| `run_steps` / `trace_payloads` | Run, ordinal, kind, status, timing, bounded redacted payload/ref | Content policy and retention separate from aggregate usage |
| `runtime_action_manifests` | Runtime instance, Space, contract hash, action schemas/versions, heartbeat | Compare with Template before execution; no handler source |
| `content_access_audit` | Actor/credential, resource, action, time | Append-only, bounded retention |
| `purge_jobs` | Scope, status, cursor, attempts, requested by/time | Idempotent background deletion, resumable after restart |

Use foreign keys and cascade only where they match the deletion policy. Large payloads may require object storage later, but then deletion and access control must cover that store too. Never rely on a dashboard hide flag as proof of purge. Usage aggregates can remain after content deletion only if they are genuinely anonymous and cannot reconstruct the deleted conversation. Database backups and provider logs have their own retention; disclose rather than promise immediate physical removal from every backup.

### Versioning and atomicity

All mutable context entries and conversation state need revision tokens. The runtime must know which revisions were assembled into the prompt. A run commit checks the conversation lease/version and writes its new messages, facts, summary, outcomes, and terminal run state consistently. If separate transactions are unavoidable, define recovery states and idempotent replay. Do not commit memory that describes an action before its outcome is known. An Agent deletion and a run commit must not race to resurrect content. Space deletion revokes all project credentials immediately and later purges dependent state through a resumable worker.

### Data sizing and retention

Publish per-entry, per-conversation, per-Agent, and per-Space caps on bytes and counts, not only “tokens.” A 3-Agent Free Space can still create huge numbers of conversations. Limit idle/unreferenced histories, open runs, retained trace payloads, action result bytes, and compaction work. Give callers typed limit errors and a way to list/delete old content. Separate retention for conversation memory, content traces, metadata usage, and audit logs. The current metadata events retain 30 days; do not silently apply that period to managed conversation memory. Managed Agents now offer opt-in 30-day idle deletion; default Agent and conversation content still require explicit deletion. Paid retention windows remain product decisions to measure and publish.

## 13. Suggested public API and SDK shape

The examples below show *intent*, not functions currently shipped. Name and error details should be finalized together with contract tests and generated docs. Keep one consistent resource vocabulary in the SDK, HTTP API, and cabinet.

### Configure a Template and create an Agent

```js
const { NullProtocol } = require('nullprotocol'); // proposed 3.0 API

const np = new NullProtocol({
  spaceKey: process.env.NULLPROTOCOL_CALLER_KEY,
  endpoint: 'https://api.nullprotocol.ai',
  credentials: {
    localModel: {
      apiKey: process.env.MODEL_API_KEY,
      baseURL: process.env.MODEL_BASE_URL,
    },
  },
});

const { template } = await np.templates.create({
  name: 'Support assistant',
  config: {
    instructions: 'Help with orders using current account data.',
    model: { provider: 'openai-compatible', model: 'your-model', credentialRef: 'localModel' },
    actions: [
      { name: 'getOrder', description: 'Read one authorized order', input: getOrderInputSchema, output: getOrderOutputSchema, effect: 'read' },
      { name: 'requestRefund', description: 'Request a policy-approved refund', input: refundInputSchema, output: refundOutputSchema, effect: 'write' },
    ],
    context: { spaceKeys: ['support/policy'] },
    memory: { mode: 'conversation' },
  },
}, { idempotencyKey: 'deploy-2026-09-support-template' });

const { agent } = await np.agents.create({
  templateId: template.id,
  name: 'Support',
}, { idempotencyKey: 'deploy-2026-09-support-agent' });
```

The Space key authenticates the Space. The model key is separate and stays in trusted code in this BYOK example. `getOrderInputSchema` and the other schema variables stand for actual JSON Schema objects supplied by the application. Do not make `templates.create` run on every request; show a deployment/bootstrap example and a normal `np.agent(id)` invocation separately. Template creation and version publishing must work in the cabinet too, with the same validation and conflict semantics. If the user creates a Template in the cabinet, code loads its ID; no duplicate hidden Template is created.

### Register actions and run an existing Agent

```js
const support = np.agent(process.env.SUPPORT_AGENT_ID);
const { version } = await np.templates.get(process.env.SUPPORT_TEMPLATE_ID);
const getOrderContractHash = version.actions.find(action => action.name === 'getOrder').contractHash;
const refundContractHash = version.actions.find(action => action.name === 'requestRefund').contractHash;

support.action('getOrder', {
  contractHash: getOrderContractHash, // checked against the published Template version
  handler: async ({ orderId }, ctx) => orders.getAuthorized(ctx.subject.id, orderId),
});

support.action('requestRefund', {
  contractHash: refundContractHash,
  handler: async ({ orderId }, ctx) => refunds.request({
    userId: ctx.subject.id,
    orderId,
    idempotencyKey: ctx.actionIdempotencyKey,
  }),
});

// This process connects an outbound executor for its registered Agents.
// Its key has runtime:connect + runs:execute; callerKey has runs:create.
await np.runtime.connect({ runtimeKey: process.env.NULLPROTOCOL_EXECUTOR_KEY, agents: [support] });

const result = await support.run({
  conversation: `ticket:${ticket.opaqueId}`,
  subject: { id: authenticatedUser.id, tenant: authenticatedUser.organizationId },
  input: incomingMessage,
  context: { order: await orders.getAuthorized(authenticatedUser.id, ticket.orderId) },
  idempotencyKey: incomingWebhook.id,
});
```

The runtime registration must use the **same contract hash** as the published Template version. An application caller and executor may live in different processes; the caller only needs a key with `runs:create`, while the executor needs `runtime:connect` and `runs:execute` plus its local model credential mappings/handlers. The actual SDK may choose a separate runtime registration object; this example should not be copied into production unchanged. The crucial semantics are explicit Agent loading, explicit action registration, trusted user identity, app-owned live context, isolated conversation, and idempotent write handling. Handler contracts need an abort signal, run ID, call ID, Agent/Template version and context revisions. Unknown Agent ID, missing action handler, or inaccessible Space Context must fail clearly before unsafe work.

### Managed state from code

```js
const np = new NullProtocol({ spaceKey: process.env.NULLPROTOCOL_SPACE_KEY });
const agent = np.agent(process.env.AGENT_ID);

const current = await np.space.context.get('ops', 'on-call');
await np.space.context.put('ops', 'on-call', { engineer: 'opaque-user-id' }, {
  ifVersion: current?.version ?? null,
});

await agent.context.put('assignment', { service: 'checkout' }, { ifVersion: null });
const memory = await agent.memory.add({ text: 'Escalate confirmed payment failures to the human operator.' });
await agent.memory.remove(memory.id);

const history = await agent.conversations.get('incident:opaque-id');
await agent.conversations.delete('incident:opaque-id');
```

The cabinet may edit Space/Agent Context through the same versioned API. It can inspect/remove memory entries, but not manually insert them under the current product decision. Deleted conversation content must disappear from linked run traces too. Preserve old `ai.spaceContext` methods as an adapter during migration, without silently starting automatic prompt injection for legacy callers. The management code above needs an appropriately scoped management key; a minimal `runs:create` caller key cannot read arbitrary history or edit context.

### HTTP API resource outline

**Founder decision:** first-release HTTP run creation lives at `api.nullprotocol.ai`. Existing `/v1/spaces/:space/agents` routes represent telemetry-discovered agents. During beta, explicit managed Agents use `/v1/spaces/:space/managed-agents`; the SDK exposes `np.agents`. A later move to `/agents` requires a coordinated API/cabinet/SDK release. Management and run routes now have development branch contract tests; proposed `/context`, `/memory`, and `/conversations` routes do not yet exist.

The run collection accepts `POST` with input, conversation, context and subject; idempotency uses the `Idempotency-Key` header. It returns `202 { run: { id, status, ... } }` for an accepted run. `GET /runs/:runId` returns status/output/usage, and v1 callers poll it; an event stream is deferred. `POST` rejects with `runtime_offline` before creating a run when no compatible executor is online. Keep `/v1/chat/completions` as the separate managed inference gateway. The existing customer-hosted `serveAgents` `/v1/agents/:id/invoke` route is a legacy/optional adapter. A non-JS application server can call the platform directly with its Space key. Browser/game clients do not receive that key.

The executor's **outbound** API is separate from the public run-create API: authenticate runtime instance and manifest, claim bounded jobs, renew lease, fetch only leased run state, append ordered steps/action outcomes, and commit or mark failure. A Postgres-backed bounded long-poll queue is a reasonable initial transport; the runtime should not need an inbound public port. The API must not assign a job to a runtime lacking its Template model credential reference or matching action contract hashes. If it loses the executor after a write action starts, keep the run/action outcome unknown and require reconciliation; do not automatically redeliver the job as a fresh execution.

Server-to-server call against a deployment with Slice B enabled:

```sh
curl -X POST 'https://api.nullprotocol.ai/v1/spaces/my-space/managed-agents/22222222-2222-4222-8222-222222222222/runs' \
  -H "Authorization: Bearer $NULLPROTOCOL_CALLER_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: webhook-opaque-id' \
  -d '{"conversation":"ticket:opaque-id","subject":{"id":"customer-opaque-id"},"input":"Where is my order?","context":{"orderStatus":"shipped"}}'
```

The response contains `run.id`; the application polls the run for status and output. A connected compatible executor must already be online; the Space key is never sent to the user's browser. Event streaming remains a later feature.

### Agreed Slice A management contract

The implementation pair agreed on these beta contracts while writing this document. The API and SDK must share executable contract tests before publication:

- New `np_space_` key: 32 random bytes encoded as 43 base64url characters after the prefix; hash at rest; shown once. Every key has explicit scopes. Old ingest/runtime/context/inference keys do not work on new managed routes, and a new Space key does not gain their old permissions. A Space key discovers its Space through `GET /v1/space` → `{ "space": { "id", "slug", "name" } }`.
- `:space` in a path must match the key's Space; otherwise return 404. Cabinet sessions follow Team membership; Space keys follow scopes. Executor keys carry `runtime:connect` and `runs:execute` and cannot be combined with management scopes or `runs:create`. App caller and executor usually have different keys.
- Management routes use `/v1/spaces/:space/templates` and `/v1/spaces/:space/managed-agents`. Existing `/agents` telemetry routes are left intact. JSON responses wrap resources as `{ "template", "version" }` or `{ "agent" }`; errors use `{ "error": "code", ... }` with no raw secret data.
- Resource creation uses an `Idempotency-Key` HTTP header, not a body field. It is 1–128 printable ASCII characters excluding whitespace. A matching replay returns the original resource; a different body returns `idempotency_conflict`. Template version publishing uses `ifVersion`; Agent edits use `ifRevision`.
- Template config schema v1 is strict. It contains `instructions`, one nonsecret `model: { provider, model, credentialRef }`, action contracts, selected Space Context keys, and memory mode. Optional defaults are normalized by the API. A `role` field is rejected until a real registry exists. Action contracts include name, description, input/output JSON Schemas, read/write effect, optional timeout/result size. A version is immutable after publish.
- `contractHash` is SHA-256 hex of canonical JSON for the action contract; `contentHash` uses the normalized whole config. Canonical JSON recursively sorts object keys in JavaScript UTF-16 `sort()` order, keeps array order, uses `JSON.stringify` values, excludes absent optional fields and has no whitespace. API and SDK share test vectors. Secret credentials are never in the hashed Template config.
- Managed Agents have UUID identities, immutable Template association, pinned Template version by default, explicit name/state/revision. Delete responds `202` with a deletion status (`completed` or `pending`); once content exists, the same purge path must finish asynchronously and block late writes. A Template referenced by a live Agent may be archived but not hard-deleted.
- Free plan target counts three non-deleted managed Agents per Team. Existing telemetry-discovered Agent quota is separate. Higher paid-plan technical caps and Template caps are safety defaults, not a finalized commercial limits table.

### Implemented Slice B backend contract (development branches)

- A caller key with `runs:create` submits `POST /v1/spaces/:space/managed-agents/:id/runs` and receives `202 {run}`; `runs:read` polls `GET` and lists run metadata. The optional `Idempotency-Key` replays the same run. Without a compatible online executor, no run is created (`runtime_offline`, `action_unavailable`, or `model_unavailable`). An active conversation returns `conversation_busy` with `Retry-After`.
- An executor key with `runtime:connect` and `runs:execute` registers one instance with explicit Agent UUIDs, action contract hashes, and nonsecret `{provider, credentialRef}` pairs. It long-polls `/executors/:instanceId/claim`, renews a 30-second lease, writes ordered bounded steps, and commits output plus conversation messages atomically. The run deadline is 180 seconds. One executor process handles one run at a time in the current SDK.
- The API supplies at most 50 recent conversation messages within 64 KiB, beginning with a user message. Selected Space Context is read at claim; a missing selected document fails the run before model invocation. This is a recent window, not the planned facts/summary compaction. Unknown provider token usage is `null`, never zero.
- The first SDK executor supports OpenAI-compatible HTTPS or loopback model endpoints with developer-held credentials. The backend and SDK passed a two-turn test against the API test database, including selected Space Context. No production deployment is implied by these development tests.

### Implemented Slice C action contract (development branches)

- An executor advertises each action's canonical contract hash and registers a matching local handler. A claimed job contains the effective action contracts, their manifest hash, unresolved write outcomes for the conversation, and an Agent revision. The SDK verifies the manifest and input/output JSON Schemas. One run is bounded to four model turns and eight tool calls. Model-selected actions outside the effective list fail before a handler runs.
- Agent action overrides only narrow permissions. They survive pin changes so an older in-flight run cannot regain a disabled action. Before a write handler, the executor refreshes Space Context and action overrides. It also refreshes context before subsequent model turns. An optional application guard must return `true` before the action starts. Stop pauses the Agent, cancels queued runs and signals running ones.
- A write handler receives a stable `runId:callId` idempotency identity for that attempt. The SDK never repeats the handler after an ambiguous result. Its timeout must fit the remaining run deadline; a write too close to the deadline is rejected before starting. Confirmed write outcomes enter conversation history as concise structured records, including when a later step makes the run fail or cancel. Failed or cancelled runs with a started write record `unknown`; the application inspects the actual side effect and reconciles the step explicitly. An unresolved write blocks another write with the same action name in that conversation; over 20 unresolved writes blocks a new run. The API exposes ordered steps and unreconciled counts. An optional guard has a five-second limit.
- Read and write action flows passed an SDK/API integration against the isolated API test database. The read flow completed, a confirmed write entered conversation history, a write returning an invalid output schema produced an `unknown` trace and unreconciled count, and a confirmed write stayed in history when the next model step failed. No production deployment or npm publication is implied.

### Slice D context and memory contract (development branches)

- Agent Context has versioned keys with compare-and-swap, expiry, and per-Agent byte/count caps. Agent memory is explicitly written by trusted code, never automatically promoted from one conversation. Both enter a claimed job and a fresh context response before later model turns or write actions. Conversation content reads and deletes use separate scopes and are audited.
- A conversation keeps the recent message window, sourced semantic facts and a short summary. The executor reads older uncompacted messages through a leased paginated source route. It processes bounded chunks with the Template model, within a time budget that preserves time for the answer, and cites source sequence numbers for extracted facts. Action outcomes remain in run steps and a bounded recent list rather than consuming the semantic fact quota. Facts and summary commit atomically with the run and conversation version. If capacity, invalid compaction output or the per-run limit leaves an uncompacted gap, the compaction step records its error, partial progress is committed, and the run may answer from the current summary and window. The prompt marks memory incomplete and write actions are disabled for that run; the missing source messages remain available for later compaction. Conversation reads expose `memoryState` with capacity, backlog and uncompacted-message indicators. If capacity remains exhausted, write actions in that conversation remain blocked until an operator deletes unnecessary facts or source messages, or deletes that conversation to start a new history.
- Before a model turn, the executor fits the assembled prompt under the request byte limit with room for a tool result. It removes the oldest sourced facts first, then earlier conversation turns, explicit Agent memory, Agent Context and optional tools. Selected Space Context, current request, summary and confirmed/unresolved write outcomes remain. A `context` step records omitted counts and Agent Context key names without values. Every later model turn is measured again: only changed reference keys are sent, and oversized tool results or prior model outputs are replaced with explicit omission markers and recorded in a `context` step. Any omission marks the prompt incomplete and disables write actions for that run; if the required data alone is too large, the run fails with `model_context_too_large` rather than silently dropping it.
- Deleting a source message invalidates its facts and any summary covering it. Conversation and Agent deletion purge their linked content; large purges complete asynchronously while new work is blocked. A confirmed write that missed history is delivered to the next run as an unrecorded outcome until it enters a committed conversation record or is explicitly reconciled. A reconciled outcome also enters history.
- The SDK/API integration test on an isolated test database covers Agent Context, Agent memory, a long seeded conversation, source pagination, compaction and the final run. Development Slice D is not a production deployment.

### API evolution

The current SDK exposes `NullProtocol` as an alias to `AIToolkit`, existing primitive functions, telemetry flags and `serveAgents`. This target API is a significant semantic change. Keep all existing 2.x constructors and methods unchanged. Build the connected constructor with `spaceKey` and the new semantics only in a `3.0.0` prerelease (or a separately named explicit export during development). The final 3.0 `NullProtocol` can be the connected API; a temporary `AIToolkit` compatibility export may keep old primitives with documented deprecation. Do not make a 2.x upgrade introduce network calls into existing code. Keep an upgrade guide with old-to-new examples, current/target status for each method, and an announced support window. Do not claim `npm install nullprotocol` works until the package is actually published. Delay npm publication until registry ownership, package contents, semver, docs, smoke install and release provenance are verified; the founder previously chose to hold publication.

## 14. Cabinet: Agent Center

The cabinet should be the place where a developer understands and controls an Agent, not merely a page of counters. Keep screens separate so the user sees a hierarchy rather than a crowded dashboard. Use the existing Radix Themes-based design system; do not invent a fresh component system or fill the interface with labels such as “Interactive example,” “Start here / 01,” or generic AI copy. Show actual resource names, state, timestamps, versions and consequences. Critical actions need clear confirmation and result feedback, but routine reversible edits should be quick.

### Proposed navigation

```text
Team
  └─ Space
      ├─ Overview: Agents, templates, recent runs, usage/limits
      ├─ Agent Templates: list → versions → config/action contracts/policies
      ├─ Agents: list → Agent detail
      │   ├─ Overview: identity, Template version, model, connection/control, recent runs
      │   ├─ Context: Agent Context plus links to Space Context
      │   ├─ Conversations: keys, last run, size, expiry → one history/facts/summary
      │   ├─ Memory: Agent-wide explicit entries, sources, delete/clear
      │   ├─ Actions: effective allowlist, handler connectivity, disable override
      │   └─ Runs/Traces: timeline, decision/guard/action outcome, usage, versions
      ├─ Activity / Usage: cross-Agent events and costs
      ├─ Space Context: keyed shared documents, versions, audit
      ├─ Connections: project/runtime/ingest/context/inference keys and runtime instances
      └─ Settings: retention, limits, Space deletion
```

These are information areas, not a mandate to create eleven top-level tabs. Give the Agent detail enough room: obvious primary status, clear Template link, then separate views for Context, Conversations, Memory, Actions and Runs. A developer should be able to answer “what happened yesterday?” by filtering runs/conversations and opening a trace, even before an AI-powered question box exists. A later “Ask this Agent” feature requires a real secure invocation path; do not implement it as a query over metadata or a fake chat if handlers are offline.

### Cabinet behavior

- Creating a Template or Agent in the cabinet uses the same API/validation as code; a new Agent appears instantly with an idle/offline state. Code-created Agents appear identically. Display the effective version and whether it is pinned or following future versions.
- A Template edit shows the affected Agents and the adoption consequence. Publishing a new version does not quietly retarget pinned Agents. Allow an explicit bulk adoption later with a dry preview.
- A model configuration shows provider/model identity and whether the runtime that can serve it is connected. Provider keys are masked. For local LLMs, show “served by your runtime,” not “hosted by NullProtocol.”
- The Agent's action view shows declared input/output shape in readable form, handler presence and manifest version, write/read designation, disable state and recent outcomes. Disabling an action should take effect on subsequent steps/runs according to the revision protocol; show pending vs applied on connected runtimes.
- Context editor operates by keys/IDs and versions, shows last updater/time, and handles conflicts. Space Context is visibly shared. Agent Context is private to one Agent. Run context is shown on a run, not edited as persistent state.
- Conversation view separates recent window, exact facts with source, summary, action outcomes, and full linked traces. Generated memory can be removed/rebuilt; do not offer an in-place text edit that would destroy provenance.
- Trace view shows steps in order: prompt/context assembly categories and versions, model call, extraction/summarization, selected action, input/output validation, app guard, handler status and usage. It must distinguish selected, started, succeeded, failed, unknown and cancelled. Include any content-capture/redaction state so missing data is not mistaken for an empty value.
- Pause/stop controls must show online instances and applied revision counts. A telemetry-only discovered ID is not a connected managed Agent. Existing discovered agents may need a separate legacy badge or migration path rather than silently becoming managed Agents.
- Deletion UI states exactly what is purged and what remains (Template, Space Context, anonymous usage, backup retention). The user can delete one conversation, clear Agent memory/context, or delete the whole Agent. Bulk deletion is a separate deliberate operation with progress and failure state.
- Keep usage numbers tied to provider-reported token counts and show missing usage explicitly. Do not manufacture token estimates as billable facts.

### Landing and onboarding copy

The product claim should emphasize creating and managing agents inside an application, with useful actions, controllable context/memory, and visibility into what they did. Show `npm install` only when actual npm publication exists; until then show the supported source install command accurately. Free BYOK/local support is worth stating plainly. Do not lead with an unverified “small models equal large models” claim. The user explicitly asked for a concise, spacious first screen, a left config/right result demonstration, meaningful use cases below, and richer telemetry examples. Keep product UI copy direct and avoid decoration that looks like documentation filler. Any pricing and deployment claim must match the real API.

The existing visual direction has a NullProtocol mark, avatars for game/assistant examples, provider logos and a more editorial layout. Keep brand assets consistent across landing, favicon, cabinet and GitHub. Use existing design system components for the cabinet. A future site iteration can show one generic mechanic diagram through a specific example: read current data → extract signals → summarize → choose among registered actions → validate/guard → record outcome. Do not imply the example is a live benchmark or production trace if it is illustrative.

## 15. Telemetry, traces, and privacy

The old SDK telemetry is opt-in metadata with no prompt or tool payload capture. The new connected Agent mode necessarily stores managed context/history and enough run state for the cabinet; its data contract must be explicit at onboarding. Do not use the old `telemetry: true` switch as a misleading proxy for “store every conversation.” Define **managed state**, **basic telemetry**, and **advanced content traces** separately:

| Category | Purpose | Baseline target |
| --- | --- | --- |
| Managed Agent state | Templates, Agents, Space/Agent Context, conversation memory | Required for connected Agent mode; disclosed and inspectable |
| Basic run metadata | Time, state, Agent/version, model, duration, provider-reported tokens, action names/status, error class | Available within Free limits |
| Content traces | Prompt inputs, messages, selected context values, action arguments/results, model output, compaction sources | Restricted access, bounded retention, redaction; advanced tier policy needs final decision |
| Usage ledger | Team/Space model calls, provider-reported usage, gateway credits when enabled | Separate from prompt content and from payment provider ledger |
| Audit | Human/API actor reads, configuration writes, deletions, key changes | Tamper-resistant enough for operational review |

Founder's direction is transparent history/context/actions/traces in the cabinet. A Free plan should still let users inspect their Agent state and enough recent run detail to debug it; advanced telemetry can offer longer retention, deeper step content, filtering/export and team visibility. Do not make “poor telemetry” mean the product is unusable or hide the state that the platform stores anyway. Final content-retention numbers and plan matrix need explicit product approval.

Strip credentials and common secret fields before persistence; offer SDK redaction hooks for domain PII, and bound payload sizes. A redaction hook is defense in depth, not a guarantee that arbitrary secrets are removed. Prefer storing references/hashes and selected structured fields when full payload is unnecessary. Human trace-content access is separate from metadata access and audited. Customer deletion must traverse derived facts, summaries, trace payloads and indexes. Provider-side logging is controlled by the chosen provider and should be documented separately.

## 16. Reliability, operations, and deployment

### Current deployment base

The API already uses Heroku and Neon. The cabinet and landing are deployed separately on custom domains `app.nullprotocol.ai` and `nullprotocol.ai`; `api.nullprotocol.ai` serves the API. Preserve those deployments and their DNS/SSL. Do not change DNS or production credentials merely to implement a new table or page. The site/cabinet currently have verified custom domains; the API README is the source for its deployed endpoints. No payment provider is connected. Current production signup remains closed. A beta invited user and production flows were exercised previously, but that is not acceptance for the new managed-agent system.

The first release should use the existing Neon PostgreSQL and Heroku process model. Keep migrations transactional where possible and deploy schema expansions before code that depends on them. A single web dyno currently holds some in-process rate limits; scaling beyond one process needs shared rate limiting or database-enforced quotas. Agent/conversation leases must work across replicas from day one, even if only one dyno exists now. Background purge/compaction jobs should be resumable and idempotent. Use a worker dyno or bounded background runner only when volume and operational needs justify it; avoid a queue product merely for architecture aesthetics.

### Runtime connectivity

One customer runtime can host many Agent action definitions. It registers one bounded manifest and heartbeat, not one service per Agent. The existing runtime control poll reports manifests every 15 seconds, starts controlled runtimes paused before first sync, and pauses/cancels after prolonged sync failure. Managed executors should preserve these fail-closed controls unless an explicit tested replacement is specified: pause before first sync, and pause new runs/request cancellation after the existing 45-second sync-failure window. A poll heartbeat alone does not deliver a run job; the first release must add the authenticated outbound claim/lease/step/commit protocol before exposing platform run creation. The cabinet shows whether each executor is online, compatible and has applied control revisions. Jobs are assigned to a compatible instance with bounded capacity; one process can execute many Agents without one connection per Agent.

The platform API is the initial “call by HTTP API” path. A customer-hosted `serveAgents` service may remain as a compatibility adapter, but is not required for server-to-server API callers. For Lambda/edge executors, separate runtime compatibility work is needed: Node dependencies, outbound connection lifetimes, local-model reachability, streaming, cold starts, action callbacks and state coordination. It is a deployment target, not a checkbox on the first release. Cron loops, webhooks and inter-Agent calls can later be run triggers that invoke the same platform Agent/run contract with explicit deduplication and permissions. They are not separate kinds of Agent.

### Observability and failure handling

The service should expose health/readiness for API and runtime, with database and state dependency checks. Instrument latency and errors per run stage, lease conflict rates, compaction failures, provider timeouts, action timeouts, disconnected runtimes, trace ingest lag and purge backlog. Alerts should key on real error conditions. If a provider gives no usage data, store `unknown`, not zero. If a runtime vanishes mid-run, preserve the last confirmed step and show interrupted/unknown. If Space Context is unavailable, do not let stale cache quietly change decisions. Every state transition and retry must be explainable from its trace/audit record.

## 17. Security and abuse cases to implement against

1. **Conversation key substitution:** with a trusted Space key, the application may address any of its Agent conversations. The application is responsible for authenticating its end user and deriving/authorizing the conversation key. A future restricted client token must bind to one exact conversation. Test that another Space or Agent cannot read it with the same string.
2. **Prompt injection through user/tool data:** the model may propose an action, but only an action in the effective allowlist runs. Guards and handlers use trusted context and app authorization. Never make a tool argument the sole evidence of ownership. Test crafted text that tries to select forbidden actions or change Template instructions.
3. **Shared memory leakage:** automatic facts from `conversation A` must never appear in `conversation B`, even after compaction, restart, template update or dashboard edit. Explicit Agent-wide writes are visible as shared and attributed to a trusted actor.
4. **Secret exposure:** Space keys, provider keys, runtime credentials and third-party tokens do not enter templates, run context, telemetry, traces, browser bundles or exception text. Scan SDK logs and API responses in tests.
5. **Side effect replay:** duplicate webhook deliveries, HTTP retries, lease recovery and model repeated calls cannot accidentally charge/refund/restart twice when the handler honors its idempotency contract. Unknown outcome is surfaced and requires reconciliation.
6. **Concurrency:** two runs on the same conversation cannot both commit an old version; different conversations can proceed concurrently. Template edits, Agent deletion and Space Context writes have CAS/lease rules.
7. **Quota abuse:** one Agent cannot create unbounded conversations, massive tool outputs, endless loops, infinite stream connections or excessive paid model spend. Enforce limits at ingress and after each stage. Return typed errors and usage context.
8. **Runtime spoofing:** a runtime manifest and callback channel authenticate to the right Space. A key with only telemetry ingest rights cannot claim an action runtime or read conversation content. Revocation takes effect predictably.
9. **Dashboard exposure:** Team membership is checked on every content read/write. Viewing content and deleting it are audited. Invite links, session tokens and plan changes do not escalate privileges through stale caches.
10. **Deletion races:** a late run commit or telemetry event must not recreate a deleted Agent/conversation; purge covers traces and derived memory, and retries resume safely after process restart.

## 18. Meaningful acceptance tests

Focus on boundary behavior rather than tests that copy the implementation. Use fake model providers and action handlers for deterministic integration tests; optional live-model smoke tests are separate and never gate basic CI. Required scenarios:

- Create Template in API/cabinet, publish version, create Agent from SDK, observe it in cabinet; reverse direction also works. Unknown Agent ID fails. Repeating creation with same idempotency key is safe; conflicting payload is a conflict.
- Create two Agents from one Template. They share behavior but have distinct context and conversation histories. Pin one to v1, publish v2, verify the pinned Agent still runs v1 and a newly created Agent runs v2. Verify explicit adoption.
- One Agent serves conversations `A` and `B`; a precise fact from `A` never reaches `B`, including after many turns and compaction. A fresh run context value is used once and does not become long-term memory by accident.
- Update Space Context from SDK and cabinet with versions. The next eligible run/step sees the update; an in-flight model request keeps the recorded older version. A stale writer receives conflict. The old explicit `ai.spaceContext` API never starts implicit injection on its own.
- Register actions with input/output schemas and guards. The effective contract reaches the model, malformed input/output is rejected, disabled action is unavailable, missing runtime action fails before model invocation, and model data cannot bypass the handler's domain authorization.
- Large log/tool result is rejected by default; opt-in batch extraction stays within its budget and reports source chunks. Exact extracted IDs/numbers survive compaction; deleting a fact removes it from future prompts and derived summary.
- Simultaneous runs on one conversation serialize or return `conversation_busy`; runs on different keys can proceed. Lease expiration, process restart, duplicate commit and deleted-Agent race cannot corrupt state.
- Repeat a run request with the same idempotency key and payload; observe one run. Change payload; observe conflict. Redeliver a write action; handler gets the same action idempotency identity. Simulate timeout after write dispatch; trace says unknown and system does not blindly repeat it.
- Pause blocks new runs; stop requests cancellation; offline runtime shows pending controls; already started side effects remain recorded. Agent deletion blocks new runs and eventually purges own content/traces but leaves Template and Space Context.
- Delete one conversation key and its linked content traces; another key and anonymous aggregate usage remain. Opt an Agent into 30-day idle deletion, verify expiry and purge of the Agent with all its histories, and verify that adoption cannot delete it immediately. A per-conversation idle timer and fresh start after that timer belong to a later release. Ensure backups/retention promises in docs match testable behavior.
- Cross-Space credentials cannot access Templates, Agents, conversations, context or traces of another Space. Browser bundles contain no Space/provider secret. A user lacking content permission sees metadata but not message/trace payloads; content reads are audited.
- Local OpenAI-compatible model path works through a connected runtime with platform-managed state. Platform outage causes a clear managed-run failure instead of a silent stale local run. A raw server-to-server `POST` to `api.nullprotocol.ai` and JS SDK `agent.run()` produce the same state/trace semantics through the same connected executor path.
- Regression suite for existing beta: auth signup gate, invited login, teams/seats, key issuance/revocation, telemetry ingest, Space Context, runtime control, managed inference **disabled** behavior, Space/account deletion. No new migration should reopen signup or gateway.

## 19. Implementation order and release gates

### Slice A — contract and migration foundation

Write the target API/error/state contracts and a short compatibility matrix against the current SDK/API. Define credential scopes, resource IDs, state ownership, schema versions, retention policy, and quota semantics. Add migrations for Template versions, explicit managed Agents, conversations, runs and content access without breaking discovered telemetry Agents. Add API-level authorization, CAS helpers, idempotency primitives and purge job infrastructure. Test storage/tenant isolation before UI work.

### Slice B — platform run API and minimal connected Agent end to end

One connected JS executor can advertise one Template-created Agent, claim a job from the platform API, fetch effective config and selected context, run one model turn, persist a run and isolated conversation history, and show it in a minimal cabinet view. `POST` to `api.nullprotocol.ai` and SDK `agent.run()` submit through the same path. Support BYOK and one compatible local endpoint. Unknown IDs, offline executor and disconnected platform fail clearly. No application action handler or billing needed yet. This is the first real product slice; it should be deployed only after production test data can be cleaned and permissions are checked.

### Slice C — actions, guards and concurrency

Register schema-defined handlers in the SDK runtime, validate the effective manifest, execute bounded model/tool steps, check application guards, enforce per-conversation lease and idempotency, and trace all outcomes. Verify multiple Agents per connected executor and no process per Agent. Add dashboard action status/disable control after the backend revision semantics work. The optional customer-hosted legacy service can be adapted later; it does not gate direct platform HTTP invocation.

### Slice D — managed context, memory and inspection

Add selected Space Context injection, Agent Context, conversation fact/window/summary compaction and explicit Agent memory operations. Implement precise provenance, deletion invalidation, version conflicts and budgets. Build cabinet Context, Conversations, Memory, Runs/Traces screens on real data with content permissions and audits. Add lifecycle deletion and optional idle TTL after purge paths pass tests.

### Slice E — polish and beta operation

Add quotas, real usage visibility, onboarding examples across support/game/DevOps and a concise upgrade guide. Run Opus review, security review, perf checks and production smoke with a disposable Team/Space. Update landing wording to describe only shipped flows; keep signup closed until the separately documented Neon Auth gates are ready. Invite beta users through the supported flow and observe costs, volume and failures. Do not publish npm or enable paid managed inference merely because the connected beta works.

### Later, separately scoped

Public signup; paid billing/provider reconciliation; managed model credits; direct restricted browser tokens; **platform-hosted** execution without a customer executor; hosted deployment to customer-selected infrastructure/edge; cron/webhook triggers; inter-Agent messaging; Python/Unreal/CLI; enterprise self-hosted storage/control plane; model routing; durable human approval/resume; AI-powered “ask Agent what happened” over authorized traces; independent benchmark claims. The outbound executor relay for platform HTTP runs is **in the first release**, not in this later list. Each later item needs its own contract and acceptance criteria.

### Gate before declaring the connected product live

- One documented source-of-truth contract and versioned migrations are deployed in correct order.
- Auth, key scopes, tenant isolation, action authorization, leases, retry behavior, deletion and trace permissions pass tests.
- SDK, API and cabinet agree on resource names and states; no mock data masquerades as production data.
- Real BYOK and local-model connected smoke tests pass; outage behavior is clear.
- Existing beta flows remain healthy and production signup/billing/gateway flags remain as intended.
- Docs explain what is current, what is planned, how credentials work, and how to migrate from 2.6.0.
- The founder can create a Template, create an Agent, call it by ID, inspect and clear its context/memory/conversation, see an action trace, and delete it with understandable consequences.

## 20. Example use cases and what belongs to the application

| Use case | Template / Agent structure | Application-owned data/actions | NullProtocol responsibility |
| --- | --- | --- | --- |
| Support | One support Template, a small number of Agents, many keyed tickets | Customer auth, order lookup, refund policy, ticket events | Isolated ticket memory, action schemas/traces, context, usage |
| Game characters | Merchant/guard Templates, explicit durable named Agents; transient encounters can reuse an Agent with separate conversation keys | World state, inventory, dialogue trigger, combat rules, save files | Character behavior config, bounded conversation memory, action calling |
| DevOps incident operator | Operator Template and Agent; a conversation per incident | Scheduler, logs/metrics, deployment permissions, restart handlers | Signal extraction, decision trace, context/memory, controls |
| CI review | Reviewer Template, conversation per build/PR | Webhook auth, repository checkout, status checks, comments | Bounded analysis steps, decision trace, idempotency |
| Moderation | Policy Template, conversation per case/content thread | Content source, final enforcement, appeal rules | Structured classification, evidence trace, guard integration |
| Data operations | Analyst Template, conversation per job | Warehouse query, credentials, data lineage | Action schema, summarization of bounded batches, run history |
| Lead qualification | Assistant Template, conversation per lead | CRM search/write, consent rules | Memory of a lead's prior discussion, action audit |
| Tutoring | Tutor Template, conversation per learner/course | Curriculum, grading rules, learner identity | Context budget, progress memory, transparent run details |
| Local automation | Operator Template, conversation per job | Filesystem/device access and OS permissions | Bounded actions, outcomes, audit |
| Equipment maintenance | Diagnostic Template, conversation per machine/incident | Sensor feed, safety interlock, work-order system | Exact fact extraction, incident summary, permitted actions |

These examples are not specialized products to build into the core. They test whether the generic Agent/Template/Conversation/Context/Action design works without bespoke flags for each vertical. A game character seeing another character's actions requires the application to route events or update shared Space/Agent Context; NullProtocol should not automatically broadcast every Agent's transcript to every other Agent.

## 21. Open decisions and proposed defaults

The coding agent may implement a clearly marked proposed default only after checking whether a newer founder answer exists. Do not bury a product choice in a database migration or UI label.

| Question | Current status | Proposed temporary default |
| --- | --- | --- |
| Exact Free conversation/run/storage limits | Not decided | Measure beta usage, enforce conservative technical safety caps, publish before charging |
| Included credits and trace retention per paid tier | Not decided | Do not activate billing or promise quantities |
| Legacy standalone primitive deprecation | Founder chose connected-only new model; old 2.6.0 has users | Keep existing release working, design major-version migration, announce date separately |
| Agent ID reuse after hard delete | Open | Tombstone ID and disallow reuse within Space |
| Conversation identifier public validation | Open | Opaque bounded identifier with one canonical normalization; no PII in examples |
| Same-key overlap behavior | Open | `conversation_busy` first; bounded queue only after measured need |
| Default content trace capture/retention | Founder wants transparency, exact tier policy open | Capture necessary managed state; restrict/redact trace content, disclose retention |
| Template Space Context selection | Open | Explicit selected keys/namespaces, no automatic all-Space injection |
| Model-invoked shared Agent memory write | Founder allows explicitly registered action; Opus advised prohibition | Keep possible only by explicit trusted action and hard scope/size/audit rules |
| Model-invoked Space Context delete | Open | No generic delete/bulk clear action registered by default |
| Dashboard “Ask this Agent” | Desired; platform execution transport is in first release | Enable only after content permission, live executor and platform run API work |
| Cron, webhook, loops, inter-Agent calls | Desired extension | Application triggers normal runs first; platform triggers later |
| Human approval during a run | Deferred | App handles approval externally and starts a new run |
| Self-hosted enterprise product | Desired later | Design portable contracts, do not promise deployable package yet |

## 22. Design and documentation drift log

Earlier notes said the runtime remains free without any NullProtocol account, key, or connection and that telemetry is optional. The founder has now chosen a **connected-only managed Agent product**. Do not erase the old implementation history or misstate existing 2.6.0 behavior. Update public docs when the new major release actually ships. The older local primitive package should be described as legacy/compatibility during transition, not as the strategic product.

Earlier docs call telemetry-discovered IDs “agents”; the new explicit Agent entity is stronger: durable creation, Template link, context/memory and lifecycle. Keep those data types distinct during migrations and UI transition. Existing named HTTP service agents are code definitions; they do not automatically become managed Agents until explicitly imported/created.

Earlier Space Context was explicit and never injected into prompts. New managed runs intend selected automatic Space Context refresh; gate it by the new run mode and a Template selection policy. Existing SDK `spaceContext.get/put/delete` must not change semantics silently.

Earlier managed inference has a 2× quote and manually assigned plan flags, but no live subscription or credits for public customers. The landing and cabinet must not say payments are active. Earlier comparison text discussed “90 vs 86” and “small model matches large”; no held-out evidence supports it. Keep benchmark claims out of marketing until the four-condition protocol in `docs/benchmark-plan.md` is run and published.

**Documentation ownership:** SDK README and generated API docs describe shipped JS behavior; API README and migrations describe deployed routes/data; cabinet README describes live flows; landing product notes describe current product messaging; this file gives the target cross-repository design. When a slice lands, update all affected owners in the same PR/deployment cycle. Run a doc drift review after Opus review and before each release.
