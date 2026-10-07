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
| `provider`, `model` | The model. `provider` is `openai`, `anthropic` or `openai-compatible`. `create` only: a loaded Agent's model comes from its Space. |
| `instructions` | Who the Agent is, what it is for and the rules it follows. `create` only. |
| `apiKey`, `baseURL` | Credentials for `provider` in `create`. |
| `credentials` | Credentials by provider, for the models this process may be asked to call: `{ openai: { apiKey }, 'openai-compatible': { baseURL, apiKey } }`. |
| `key` | An SDK key of a Space. `create` saves the Agent there; without it the Agent lives in the process. `load` needs it and fails with `key_required` otherwise. |
| `endpoint` | Another NullProtocol API address. Default `https://api.nullprotocol.ai`, or `NULLPROTOCOL_API_URL`. |
| `agentId` | The Agent's ID. `create` issues one when it is left out and fails with `agent_exists` when it is taken. |
| `conversation` | Binds the object to one conversation: its `context` and `memory` are then that conversation's own, on top of the Agent's. |
| `label` | A name for this process, such as `backend` or `worker`. It only filters history. |
| `timeout`, `retry`, `circuitBreaker` | 30000 ms, `{ maxRetries: 2 }`, `{ threshold: 5, resetAfterMs: 60000 }` by default. |
| `temperature`, `maxTokens` | Sent to the model. `maxTokens` is 1000 by default. |
| `repairAttempts` | Extra turns the model gets to fix an unusable reply. Default 1. |
| `maxPromptBytes` | The largest request body sent to a model. Default 131072. Set it lower for a model with a small window; it is bytes, not tokens. |

`create` and `load` throw an `AgentError` with a `code`: `key_required`, `key_refused` (the key is invalid, revoked or not an SDK key), `agent_not_found`, `agent_exists`, `platform_unavailable`.

Every object has an `instanceId`, issued when it is made. History records it, so the operations of one process can be told apart; nothing is stored under it.

## Results

Every operation returns `{ success: true, ... }` or `{ success: false, error, errorCode }`, with `attempts`, `repaired` and `usage: { inputTokens, outputTokens }`, the tokens the provider reported, when it reported them for every reply it gave. With a key, `historyError` is set when the operation ran but could not be recorded.

| `errorCode` | Meaning |
| --- | --- |
| `invalid_reply` | The model answered, but no reply passed the check. |
| `guard_rejected` | The guard passed to `decide` did not return `true`; `rejectedAction` names the action. |
| `agent_paused` | The Agent is paused. |
| `action_disabled` | Every action offered to `decide` is disabled in the Agent's settings. |
| `context_key_not_found` | `contextKeys` names an entry the Agent does not have. |
| `model_context_too_large` | The request is larger than `maxPromptBytes`. Nothing was left out and the model was not called. |
| `model_unavailable` | This process has no credentials for the Agent's provider. |
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

A nested object made only of schema keywords is JSON Schema: `{ address: { type: 'string' } }` makes `address` a string. An invalid schema fails before the model is called.

## summarize

```js
const result = await agent.summarize(content, { maxLength: 200, focus: 'key_insights', contextKeys });
// { success: true, summary, keyPoints }
```

A summary longer than `maxLength` characters is not accepted.

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

## Actions

```js
agent.registerAction(name, handler, { description, input, guard });
const run = await agent.execute(decision);
// { success: true, outcome: 'completed', action, result }
// { success: false, outcome: 'refused' | 'failed', action, error, errorCode }
```

`execute` takes the successful result of this object's `decide` and runs what was decided, whatever happened to the returned object since. Before the handler: the Agent must not be paused, the action must be registered and not disabled, `parameters` must match `input` (a JSON Schema), and `guard(parameters, decision)` must return `true`. A guard that throws refuses. One decision runs once: a second `execute` is refused with `already_executed`.

The handler receives `(parameters, { decision, input, reply })`. `reply(message)` asks the decision's own model for a plain-text answer; the built-in `chat` action answers `message`, or what the decision was about when the model gave none.

## Context

```js
await agent.context.set(key, value, { inclusion, ifVersion });
await agent.context.get(key);
await agent.context.list();
await agent.context.delete(key);
```

`value` is text or JSON. `inclusion: 'always'` (the default) sends the entry with every operation and holds 8 KiB; `'selected'` sends it only with operations that name its key in `contextKeys`, and holds 64 KiB. An Agent has up to 50 entries in each scope.

With a key, `ifVersion` guards concurrent writers: `null` creates only, a version replaces only that version, and without it the entry is overwritten. `agent.space` has the same four calls for context shared by every Agent of the Space.

An operation receives the entries of the Space, the Agent and its conversation. Under one key the narrowest scope wins, and then that entry's `inclusion` decides whether the operation gets it.

## Memory

```js
await agent.memory.add(text);
await agent.memory.list();
await agent.memory.delete(id);
```

Notes are short facts the Agent keeps in mind in every operation. An object bound to a conversation adds notes to that conversation and sees the Agent's and its own. Nothing is added to memory on its own: an operation does not remember the one before it.

## Settings

```js
await agent.settings(); // { provider, model, instructions, paused, disabledActions, ... }
await agent.update({ model: 'gpt-4.1', paused: true, disabledActions: ['refund'] });
```

`update` changes `provider`, `model`, `instructions`, `name`, `paused` and `disabledActions`. With a key it changes the saved Agent, and so does the cabinet; either applies from the next operation of every process. An operation already running keeps the settings it started with, and so does the `execute` of a decision already made, except that a pause or a disabled action stops it.

## What is sent where

To the model's provider: the instructions, the context and memory of the operation, and its input. Without a key, nothing is sent to NullProtocol. With a key, NullProtocol stores the Agent's settings, context and memory, and for 30 days every operation: its input and result, the instructions and context text it ran with, the model, the number of HTTP attempts made to it, retries included, and the size of their bodies, token counts, and each action's parameters, outcome and result. Model keys are never sent.
