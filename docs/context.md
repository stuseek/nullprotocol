# Context, notes and customer data

An operation receives the agent's instructions, its included context values, saved notes, reference texts and your input. It does not automatically remember previous operations.

## Context values

Use `agent.context.set(key, value)` for named text or JSON data. Entries are included in every operation unless saved with `{ inclusion: 'selected' }`. Include selected entries with the operation's `contextKeys` option.

```js
await agent.context.set('shop', { currency: 'EUR', returnDays: 30 });
await agent.context.set('order', { id: 42 }, { inclusion: 'selected' });
await agent.extract('Read the return window.', { days: 'number' }, { contextKeys: ['order'] });
```

`agent.context.get(key)`, `.list()` and `.delete(key)` read or remove values. For saved agents, `{ ifVersion }` guards concurrent updates. See [the context reference](operations.md#context) for limits and version checks.

## Shared data

`agent.space` has the same methods as `agent.context`. Its values are shared by every saved agent in the Space. An agent's entry replaces a shared entry with the same key.

## Separate data for a customer or ticket

The `conversation` option is an ID you choose. It gives one customer, ticket or conversation its own context and notes; it does not create a chat session or automatically save chat messages.

```js
import { NullProtocol } from 'nullprotocol';

const customer = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: 'support',
  conversation: 'customer:42'
});
await customer.context.set('profile', { name: 'Dana', plan: 'Gold' });
await customer.memory.add('Asked about order 6642.');
```

Operations on this object receive shared and agent values plus this customer's values. Under one key, the customer's value replaces the agent's, which replaces the shared value. Other customers' data is not included. Use saved agents for separate customer storage.

## Notes

`agent.memory.add(text)` saves a short fact. `.list()` reads notes and `.delete(id)` removes one. The agent's notes and the current customer's notes are included in every operation. Nothing is added automatically.

## Reference texts and budgets

Policies and other reference texts managed in the cabinet are included automatically and in full. An operation records the revisions it used. [Reference texts](documents.md) explains storage and document budgets.

When documents exceed `documentBudget`, or the complete request exceeds `maxPromptBytes`, the operation fails rather than leaving data out. These budgets are not token-window estimates. The model server's own behavior is described in [Models and credentials](providers.md#request-limits).

## History and privacy

With a Space key, History stores operation inputs, results and the instructions and context they used for 30 days, including texts. Check `result.historyError` if a result could not be recorded. Provider-reported tokens appear in `result.usage` and History; unreported usage is unknown, not zero.

Without a Space key, nothing is sent to NullProtocol. For your own providers, the application calls the model directly. For a NullProtocol model, the model request goes through NullProtocol. Upstream provider keys stay in the application or on the NullProtocol server, respectively.
