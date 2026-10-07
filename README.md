<img src="assets/nullprotocol.png" alt="NullProtocol" width="88" height="88" />

# NullProtocol

An Agent with a model, instructions, context and memory, and four operations whose replies are checked in code: `extract`, `summarize`, `validate` and `decide`. Change the model without changing the calls. Run it with no account at all, or add one key and see every operation in the [cabinet](https://app.nullprotocol.ai).

## Install

```sh
npm install nullprotocol
```

Node.js 18 or newer. No other packages are needed for OpenAI, Anthropic or a local model.

## Create an Agent and call it

With a local model you need no account and no key:

```sh
ollama pull qwen2.5:3b-instruct
```

```js
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.create({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  instructions: 'You read orders for Mugs & Co. Use only what the text says.',
  timeout: 120000 // a local model can take longer than the 30-second default
});

const order = await agent.extract('Order 42: two blue mugs', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});

if (order.success) console.log(order.data); // { orderId: 42, quantity: 2, item: 'blue mugs' }
else console.error(order.errorCode, order.error); // ask again, use a stronger model, or send for review
```

The same code runs on a hosted model. Its key is read from the provider's own variable:

```js
await NullProtocol.create({ provider: 'openai', model: 'gpt-4.1-mini' }); // OPENAI_API_KEY
await NullProtocol.create({ provider: 'anthropic', model: 'claude-sonnet-5-5' }); // ANTHROPIC_API_KEY
```

## The four operations

Each one asks the model for JSON, checks the reply in code and, when the reply is unusable, shows the model the exact problem and asks once more. A result is `{ success: true, ... }` or `{ success: false, error, errorCode }`; an operation does not throw for a bad reply.

```js
const read = await agent.extract(text, schema);          // data that matches the schema
const brief = await agent.summarize(text, { maxLength: 200 }); // summary, keyPoints
const check = await agent.validate(criteria, subject);   // score, recommendation, reasoning
const next = await agent.decide(ticket, ['refund', 'escalate', 'chat']); // one of the actions
```

The model reads; your code calculates and applies the rules. [Operations](docs/operations.md) has every option, the schema forms and the error codes.

### Actions

`decide` only chooses. `execute` runs the handler you registered for the chosen action, after the action's schema and guard, and once per decision:

```js
agent.registerAction('refund', ({ orderId }) => refunds.create(orderId), {
  description: 'Refund an order the customer asks to return',
  input: { type: 'object', properties: { orderId: { type: 'number' } }, required: ['orderId'] },
  guard: ({ orderId }) => orders.isRefundable(orderId) // your rule, in your code
});

const decision = await agent.decide(message, ['refund', 'escalate', 'chat']);
if (decision.success) console.log(await agent.execute(decision));
```

The model is shown each registered action's description and schema, and `execute` checks the parameters against that same schema.

`chat` is built in: when a decision chooses it, `execute` answers in plain text with the same model. There is no separate chat mode.

## Context and memory

```js
await agent.context.set('region', { region: 'EU', currency: 'EUR' }); // sent with every operation
await agent.context.set('refund-policy', policyText, { inclusion: 'selected' }); // a document, sent when named
await agent.memory.add('Keep answers under three sentences.');

await agent.extract(question, schema, { contextKeys: ['refund-policy'] });
```

Nothing is dropped silently. If instructions, context, memory and input do not fit the request budget (`maxPromptBytes`, 128 KiB by default), the operation fails with `model_context_too_large` and the model is not called.

## Add a key: the same Agent, saved

Create an SDK key in a Space of the [cabinet](https://app.nullprotocol.ai) and pass it as `key`. The calls stay the same.

```js
// Once: create the Agent. It gets an ID; pass agentId to choose it yourself.
const agent = await NullProtocol.create({
  key: process.env.NULLPROTOCOL_KEY,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  instructions: 'You are the support agent of Mugs & Co.'
});
console.log(agent.agentId);

// Anywhere, any number of processes: load it by its ID.
const support = await NullProtocol.load({ key: process.env.NULLPROTOCOL_KEY, agentId: agent.agentId });
const order = await support.extract(message, schema);
```

| | Without a key | With a key |
| --- | --- | --- |
| Agent | lives in the process | saved in the Space under one `agentId`; create it in code or in the cabinet |
| Model and instructions | set in code | set on the Agent; a change in the cabinet or by `agent.update()` applies from the next operation of every process |
| Context and memory | in the process | saved; shared by every process that loads the Agent |
| History | none | every operation with its input, result, the instructions and context it ran with, the requests and tokens it used, and the outcome of its action, kept for 30 days |
| Pause, disabled actions | `agent.update({ paused: true })` | also from the cabinet, for every process |
| Sent to NullProtocol | nothing | all of the above, texts included |

One `agentId` in one Space is one Agent, however many processes load it. An operation makes one read and one write to NullProtocol and waits for the write before it returns, so a short-lived function loses nothing and needs no `close()`. The key is not a model key: model keys stay in your process and are never sent to NullProtocol.

If the Agent's model changes to a provider your process has no credentials for, the operation fails with `model_unavailable` and says so in history. Give a process the credentials of the providers it may be asked to call:

```js
await NullProtocol.load({
  key,
  agentId: 'support',
  credentials: { 'openai-compatible': { baseURL: 'http://localhost:11434/v1' } }
});
```

### One customer, one conversation

Bind an object to a conversation and its context and memory become that conversation's own, on top of the Agent's:

```js
const dana = await NullProtocol.load({ key, agentId: 'support', conversation: 'telegram:42' });
await dana.context.set('profile', 'Name: Dana. Plan: Gold.');
await dana.memory.add('Asked about order 6642.');
await dana.decide(message, actions); // sees the Agent's context and Dana's, and nobody else's
```

`agent.space` is context shared by every Agent of the Space. Under one key the conversation's entry replaces the Agent's, and the Agent's replaces the Space's.

## Providers

| `provider` | Calls | Credentials |
| --- | --- | --- |
| `openai` | the OpenAI chat completions API | `apiKey` or `OPENAI_API_KEY` |
| `anthropic` | the Anthropic messages API | `apiKey` or `ANTHROPIC_API_KEY` |
| `openai-compatible` | any server with the OpenAI chat API: Ollama, vLLM, LM Studio, Mistral, and others | `baseURL`, and `apiKey` if the server needs one |

The operations are tested on local models through `openai-compatible`. The `openai` and `anthropic` requests follow the providers' published APIs and have not yet been run against paid accounts in this release.

## Documentation

- [Operations](docs/operations.md): options, schemas, actions, context, settings, error codes
- [Runnable flows](examples/flows/README.md): refund, invoice and SLA, where the model reads and code decides
- [Benchmark](bench/README.md)
- [Changelog](CHANGELOG.md)

## Development

```sh
npm install
npm run validate
```

## License

MIT
