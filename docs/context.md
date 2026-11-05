# Context, memory and scopes

An agent keeps its configuration. Each operation receives its input plus the saved information included for that call. It does not remember preceding calls automatically.

## What goes into a call

| Information | Included when |
| --- | --- |
| Instructions | Every operation |
| Reference texts, added under Context in the cabinet | Every operation, in full, within `documentBudget` |
| Named values written with `context.set()` | Every operation for `always`; only when named in `contextKeys` for `selected` |
| Facts written with `memory.add()` | Every operation in the applicable scope |
| Knowledge documents | The call requests `knowledge`; only selected passages are included |
| Operation input | That call only |

Reference texts, named values and notes keep their separate APIs and namespaces. Saving one does not create or update another. [Knowledge](knowledge.md) is a separate searchable library.

## Named values

```js
// Included in every operation on this agent.
await agent.context.set('shop', { currency: 'EUR', returnDays: 30 });

// Included only when this key is requested.
await agent.context.set('order', { id: 42, delivered: true }, { inclusion: 'selected' });
const result = await agent.extract(
  'Read the order ID and shop currency.',
  { orderId: 'number', currency: 'string' },
  { contextKeys: ['order'] }
);
```

Use `.get(key)`, `.list()` and `.delete(key)` to read or remove values. On saved agents, `ifVersion: null` creates only, a version replaces that version, and omitting it overwrites. Limits and concurrency details are in the [context reference](operations.md#context).

`agent.space` has the same methods for values shared by agents in that Space. A narrower entry replaces a broader one under the same key, before its `inclusion` is checked.

## Scoped data

Use `conversation` to choose a saved data scope. Despite the field name, its ID can identify anything your application works on: an order, project, job, device, user, ticket or session. It is not a chat feature.

```js
import { NullProtocol } from 'nullprotocol';

const order = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: 'order-reviewer',
  conversation: 'order:42'
});
await order.context.set('delivery', { method: 'courier', delivered: true });
const note = await order.memory.add('The buyer supplied a photo of the damaged packaging.');
```

Calls on this object receive Space data, agent data and data for `order:42`. Other scope IDs are excluded. Under the same context key or reference-text name, the scope replaces the agent, which replaces the Space. Notes are combined: agent-wide notes plus this scope's notes.

| ID example | Data is reused for |
| --- | --- |
| `order:42` | Work on order 42 |
| `project:alpha` | Work on project alpha |
| `job:import-8` | That import job |
| `user:42` | Calls for user 42, across sessions |
| `user:42:session:abc` | Calls using that session ID |

IDs are flat strings, not a hierarchy. `user:42:session:abc` does not inherit `user:42`. Reusing an ID reads the same saved data across processes and restarts. A session-like name does not expire its data; remove it explicitly when appropriate. Hosted IDs are 1–128 characters without control characters.

Your backend chooses and authorizes the ID. A Space SDK key can access its Space's scopes; the ID itself is not a permission boundary between your end users. Keep the key on your backend. Scoped persistence requires a saved agent; without a Space key, each standalone agent has its own in-process store.

Knowledge connections belong to the agent, not to individual scope IDs. Setting `conversation` does not narrow the connected Knowledge library or create scope-specific Knowledge.

## Saved notes

```js
const notes = await order.memory.list();
await order.memory.delete(note.id);
```

`.add()` returns the new note, including its ID; use that ID to remove a particular note. `.list()` includes agent-wide notes and the current scope's notes.

Save shared facts on an agent loaded without `conversation`; they reach every scope. Load with the intended scope before saving facts about one entity. Every applicable note is included in each call; there is no automatic memory search or extraction. Keep dialogue history in your application and pass the required messages as operation input.

Saved settings, context and notes stay until deleted. The 30-day retention applies to operation History, not to memory.

## Reference texts and budgets

Reference texts managed under Context in the cabinet are included automatically and in full. [Reference texts](documents.md) explains revisions and the default 6000-character budget. Named values and notes are not counted against that document budget; they still contribute to the complete model request.

The full serialized request must fit `maxPromptBytes`. These character and byte limits do not measure the model's token window. See [model request limits](providers.md#request-limits).

## History and data handling

With a Space key, History keeps operation input, result, instructions and the context used for 30 days, including texts. Check `historyError` when recording fails. Generation usage is in `usage`; Knowledge search usage is separate in `knowledgeUsage`. Unknown usage is not zero.

Without a Space key, nothing is sent to NullProtocol; your application calls its own model provider. Saved agents use the NullProtocol gateway. See [Knowledge data handling](knowledge.md#data-and-usage) for embedding requests and [models](providers.md) for credentials.
