# Operations

Everything an Agent does, with its options and error codes. The [README](../README.md) has the short path.

## Creating and loading

```js
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.create({ provider, model, instructions, key, agentId, name, ...call });
const same = await NullProtocol.load({ key, agentId, ...call });
```

| Option | Meaning |
| --- | --- |
| `provider`, `model` | The model. `provider` is `nullprotocol`, `openai`, `anthropic`, `ollama` or `openai-compatible`. `create` only: a loaded Agent's model comes from its Space. |
| `instructions` | Who the Agent is, what it is for and the rules it follows. `create` only. |
| `apiKey`, `baseURL` | Credentials for `provider` in `create`. |
| `credentials` | Credentials by provider, for the models this process may be asked to call: `{ openai: { apiKey }, 'openai-compatible': { baseURL, apiKey } }`. |
| `key` | An SDK key of a Space. `create` saves a `nullprotocol` Agent there; external providers use standalone agents without a Space key. `load` needs it and fails with `key_required` otherwise. |
| `endpoint` | Another NullProtocol API address. Default `https://api.nullprotocol.ai`, or `NULLPROTOCOL_API_URL`. |
| `agentId` | The Agent's ID. `create` issues one when it is left out and fails with `agent_exists` when it is taken. |
| `conversation` | An application-chosen scope ID for any entity or unit of work, such as `order:42`, `project:alpha` or `user:42`. Calls receive that scope's data plus agent/Space data. IDs are flat, not nested; they do not create chats. See [scoped data](context.md#scoped-data). |
| `label` | A name for this process, such as `backend` or `worker`. It only filters history. |
| `timeout`, `retry`, `circuitBreaker` | 30000 ms, `{ maxRetries: 2 }`, `{ threshold: 5, resetAfterMs: 60000 }` by default. |
| `temperature`, `maxTokens` | Sent to the model. `maxTokens` is 1000 by default. |
| `documentBudget` | How much of a saved Agent's documents an operation is given, in characters. Default 6000. Documents are given whole, and an operation whose documents do not fit fails with `documents_too_large`. It bounds the documents, not the whole request. |
| `repairAttempts` | Extra turns the model gets to fix an unusable reply. Default 1. |
| `maxPromptBytes` | The largest request body sent to a model. Default 131072. It is bytes, not tokens, and is not the model's window: see [Models and credentials](providers.md#request-limits). |

`create` and `load` throw an `AgentError` with a `code`: `invalid_options` (missing or invalid setup fields, detected before a network request), `key_required`, `key_refused` (the key is invalid, revoked or not an SDK key), `agent_not_found`, `agent_exists`, `managed_provider_required` (saved agents use NullProtocol models), `platform_unavailable`.

Every object has an `instanceId`, issued when it is made. History records it, so the operations of one process can be told apart; nothing is stored under it.

## Results

For `provider: 'nullprotocol'`, `key` is required and credentials are automatic in both `create` and `load`. It uses the Space's enabled model catalogue and credit. A retry of the same model request keeps its request ID to prevent a duplicate upstream charge; it does not replay a previously completed response. The cabinet’s Try agent uses the same four operation implementations. `decide` there chooses an action; registered handlers still run in your application.

Every operation returns `{ success: true, ... }` or `{ success: false, error, errorCode }`, with `attempts`, `repaired` and `usage: { inputTokens, outputTokens }`, the tokens the provider reported, cached input included. A failed operation has it too: the tokens of a reply that was cut off or refused are counted. A request the provider did not count, such as one that failed or timed out, is not zero tokens: `usage.uncountedRequests` says how many there were, and `usage` is absent when the provider counted none. With a key, `historyError` is set when the operation ran but could not be recorded.

| `errorCode` | Meaning |
| --- | --- |
| `invalid_reply` | The model answered, but no reply passed the check. |
| `guard_rejected` | The guard passed to `decide` did not return `true`; `rejectedAction` names the action. |
| `agent_paused` | The Agent is paused. |
| `action_disabled` | Every action offered to `decide` is disabled in the Agent's settings. |
| `context_key_not_found` | `contextKeys` names an entry the Agent does not have. |
| `documents_too_large` | Reference texts exceed `documentBudget`. The error gives the total and budget; the refusal is recorded before any model call. |
| `managed_provider_required` | A saved agent uses an external provider. Choose a NullProtocol model in the cabinet before its next hosted operation. |
| `model_context_too_large` | The request is larger than `maxPromptBytes`, or Ollama refused it as larger than the model's window. Nothing was left out and the model did not answer. |
| `model_unavailable` | This process has no credentials for the Agent's provider, or the hosted model is not configured. |
| `spend_cap_reached` | The team has insufficient model credit for this request. |
| `inference_unavailable`, `managed_inference_not_enabled`, `plan_required`, `model_not_allowed` | The hosted gateway or this team’s model access is unavailable. |
| `in_progress`, `already_completed`, `request_outcome_unknown` | A hosted request ID has already been used; the SDK does not dispatch another paid request with it. Check history before starting a new operation. |
| `rate_limited`, `provider_error` | The provider refused or failed, also after retries, or its reply was cut off or empty. |
| `key_refused`, `platform_unavailable` | With a key: the Space could not be read, so the operation did not run. |

## extract

```js
const result = await agent.extract(data, schema, { contextKeys });
// { success: true, data }
```

A schema is shorthand or JSON Schema:

```js
// Shorthand: every key is a required field, so this has a field named "items".
await agent.extract(text, { vendor: 'string', items: 'string[]' });

// JSON Schema is used as is. A field that may be missing allows null; tell the model in the
// instructions or the input to use null when the text does not say, and check what matters in code.
await agent.extract(text, {
  type: 'object',
  properties: { id: { type: 'string' }, days: { type: ['number', 'null'] } },
  required: ['id', 'days']
});

// A list is a list, also of one item.
await agent.extract(text, { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } });
```

A nested object made only of schema keywords is JSON Schema: `{ address: { type: 'string' } }` makes `address` a string. A `format` such as `date`, `date-time`, `email` or `uri` is checked, so `2026-02-29` is not a date. An invalid schema, or one with a format that cannot be checked, fails before the model is called.

## summarize

```js
const result = await agent.summarize(content, { maxLength: 200, focus: 'key_insights', contextKeys });
// { success: true, summary, keyPoints }
```

The SDK defaults to `maxLength: 200` and `focus: 'key_insights'`. A summary longer than `maxLength` JavaScript string characters is not accepted. The HTTP API and Try agent default to 1000 characters; set an explicit limit when you need the same task across integrations.

## validate

```js
const result = await agent.validate(criteria, subject, { reference, contextKeys });
// { success: true, score, recommendation, reasoning }
```

`score` is from 0 to 1 and `recommendation` is `pass`, `fail` or `conditional`. `reference` is what to compare the subject with, if anything. The verdict is the model's judgement: use it to sort and to flag, and keep hard rules in code.

## decide

```js
const result = await agent.decide(context, actions, { guard, contextKeys });
// { success: true, action, parameters, reasoning }
```

`actions` are names or `{ action, description }`. The model can only choose one of them; an action disabled in the Agent's settings is not offered. A registered action is shown to the model with its description and its parameters schema, so neither needs repeating here. `guard(decision)` is your own check of the choice and must return `true`.

A decision can be used just as a payload. Registering and executing a handler is optional. Parameter schemas are shown during `decide`, but enforced before a registered handler runs in `execute`. If your application consumes `parameters` directly, validate them in your code. [Actions guide](actions.md) shows message delivery, catalogue lookup and execution errors.

## Actions

```js
agent.registerAction('send_message', ({ text }) => sendToCustomer(text), {
  description: 'Send a reply to the customer',
  input: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  }
});
const decision = await agent.decide('Добрый день', ['send_message']);
if (!decision.success) throw new Error(decision.error);
const run = await agent.execute(decision);
// { success: true, outcome: 'completed', action, result }
// { success: false, outcome: 'refused' | 'failed', action, error, errorCode }
```

`sendToCustomer` is your application's delivery function. The model prepares `parameters.text` during `decide`; the handler sends that text without a second model call. Actions are registered by the application. An unregistered action is refused with `action_not_registered` before a handler or model can run. See [the built-in chat migration](actions.md#upgrading-from-sdk-23) when upgrading an application that relied on that handler.

`execute` takes the successful result of this object's `decide` and runs what was decided, whatever happened to the returned object since. Before the handler: the Agent must not be paused, the action must be registered and not disabled, `parameters` must match `input` (a JSON Schema), and `guard(parameters, decision)` must return `true`. A guard that throws refuses. One decision runs once: a second `execute` is refused with `already_executed`.

The handler receives `(parameters, { decision, input, reply })`. A handler can explicitly call `reply(message)` for another model-generated answer using the decision's model, instructions and reference snapshot. Its model requests and tokens are counted with the action. Returning or delivering prepared parameters does not call the model.

## Context

```js
await agent.context.set(key, value, { inclusion, ifVersion });
await agent.context.get(key);
await agent.context.list();
await agent.context.delete(key);
```

`value` is text or JSON. `inclusion: 'always'` (the default) sends the entry with every operation; `'selected'` sends it only with operations that name its key in `contextKeys`. For saved agents, each scope holds up to 50 entries: 8 KiB per `always` entry and 64 KiB per `selected` entry. These storage limits are enforced by the server; the standalone in-memory store does not enforce them. Every model request still has its `maxPromptBytes` limit.

With a key, `ifVersion` guards concurrent writers: `null` creates only, a version replaces only that version, and without it the entry is overwritten. `agent.space` has the same four calls for context shared by every Agent of the Space.

An operation receives the entries of the Space, the Agent and the selected data scope (`conversation`). Under one key the narrowest scope wins, and then that entry's `inclusion` decides whether the operation gets it. Scope IDs can identify any entity or unit of work; they do not inherit from one another.

## Memory

```js
await agent.memory.add(text);
await agent.memory.list();
await agent.memory.delete(id);
```

Notes are short facts included in every operation in their scope. An object loaded with `conversation` writes notes for that ID and reads its own plus agent-wide notes. An object without it writes agent-wide notes used by every scope. With a key, each scope holds up to 200 notes of 4 KiB. Nothing is added automatically, and History retention does not expire saved notes. [Scoped data and memory](context.md#scoped-data) explains isolation.

## Settings

```js
await agent.settings(); // { provider, model, instructions, paused, disabledActions, ... }
await agent.update({ paused: true, disabledActions: ['refund'] });
```

`update` changes `provider`, `model`, `instructions`, `name`, `paused` and `disabledActions`. A saved agent must keep `provider: 'nullprotocol'` and use a model allowed for its team. With a key it changes the saved Agent, and so does the cabinet; either applies from the next operation of every process. An operation already running keeps the settings it started with, and so does the `execute` of a decision already made, except that a pause or a disabled action stops it.

## What is sent where

To the model's provider: the instructions, included context and notes, reference texts, selected Knowledge passages when requested, and operation input. Knowledge preparation and search queries separately go to Mistral's embedding API. Without a Space key, nothing is sent to NullProtocol. With one, NullProtocol stores settings and saved data until deleted, and operation History for 30 days: input/result, the instructions and context used, source revisions, model, request counts and bytes, usage and recorded action outcomes. Keys for your own model providers are never sent to NullProtocol. With `provider: 'nullprotocol'`, the Space SDK key authorizes the model request through NullProtocol; the upstream model key stays on the server.

## Knowledge

All four operations accept optional `knowledge: true | false | { query: string }`. Omitted or false means no retrieval. An agent searches only its own sources and explicitly connected Space documents. [Knowledge](knowledge.md) describes preparation, source snapshots, query limits and failures. It requires SDK 2.3 and an enabled server; existing Context behavior is unchanged. Knowledge sends document sections and search queries to Mistral for embeddings, separately from the selected generation provider.

## Photo input

All four operations accept `images: ['https://…']` in their options. Supply up to four reachable HTTPS URLs, each at most 2048 characters, without embedded credentials. Text arguments can be empty for a photo-only task. The selected model must support Vision; native Ollama URL input is not supported. Text requests are unchanged when images is absent or empty.

Provider file-size and format limits still apply; `image_too_large` means a photo must be resized. Image parts stay attached through repair attempts. Knowledge uses the task text or an explicit query, never photo URLs. History keeps the supplied URLs; it does not copy remote image bytes. The hosted gateway holds a conservative reserve based on the model context ceiling, then charges reported generation usage and releases the unused reserve. `invalid_images`, `model_images_not_supported` and `provider_images_not_supported` identify unsupported input before provider generation. [Example](../examples/photos.mjs).
