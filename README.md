<img src="assets/nullprotocol.png" alt="NullProtocol" width="88" height="88" />

# NullProtocol

Give an AI agent a focused job. Extract typed data, summarize text, check an answer or choose an action. Manage its instructions and context in the [cabinet](https://app.nullprotocol.ai), and see the input, result and token usage of each operation. The agent keeps the configuration; each SDK or HTTP request chooses which operation to run.

```sh
npm install nullprotocol
```

Node.js 18 or newer. JavaScript and TypeScript. CommonJS and ESM.

## Run your agent

Create an agent in the cabinet, choose a NullProtocol model, and copy a Space SDK key from **Connect**. Set `NULLPROTOCOL_KEY` in your application's environment. Your team needs model access and available credit.

Save this as `agent.mjs`, replacing `order-reader` with your agent's ID:

```js
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: 'order-reader'
});

const result = await agent.extract('Order 42: two blue mugs.', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});

if (result.success) {
  console.log(result.data); // { orderId: 42, quantity: 2, item: 'blue mugs' }
  console.log(result.usage); // Provider-reported input and output tokens.
} else {
  console.error(result.errorCode, result.error);
}
```

```sh
node agent.mjs
```

The same SDK key loads the saved agent and authorizes its NullProtocol model. No separate model key is needed. Edit its instructions or context in the cabinet; the next operation uses the changes.

## Four operations

| Call | Result on success |
| --- | --- |
| `agent.extract(text, schema)` | `data` matching your schema |
| `agent.summarize(text)` | `summary`, `keyPoints` |
| `agent.validate(criteria, subject)` | `recommendation`, `score`, `reasoning` |
| `agent.decide(input, actions)` | `action`, `parameters`, `reasoning` |

Every operation returns `success: true` or `success: false` with `errorCode` and `error`. Invalid model replies get one repair attempt by default. Schema validation checks the output's structure; your code still checks facts and business rules.

`decide` chooses an action and prepares its parameters. Register your application's handlers, such as `send_message` or `search_catalog`, then pass the decision to `agent.execute(decision)`. Sending prepared text does not need another model call. [Decisions and application actions](docs/actions.md) covers delivery, catalogue lookup and execution checks.

## Give it the right context

```js
// Included in every operation.
await agent.context.set('shop', { currency: 'EUR', returnDays: 30 });

// Included only when the operation asks for it.
await agent.context.set('order', { id: 42, delivered: true }, { inclusion: 'selected' });
const result = await agent.extract('Read the order ID and shop currency.', { orderId: 'number', currency: 'string' }, {
  contextKeys: ['order']
});

// A shared fact about the agent's work, included in every operation.
await agent.memory.add('The warehouse ships on weekdays.');
```

Reference texts added under Context in the cabinet are included automatically and in full. Knowledge documents are searched only when a call requests `knowledge: true` or `{ query }`; only selected passages are included. History keeps the source revisions and selected evidence. [Context, memory and scopes](docs/context.md) explains what each call receives.

## Separate data for any entity

Load with `conversation: 'order:42'`, `'project:alpha'`, `'job:import-8'` or another ID chosen by your application. Despite its name, `conversation` is a general saved-data scope. It selects that entity's context and notes alongside agent-wide data.

IDs are flat. Use `user:42` for facts reused across that user's sessions, or a different ID for each session. Notes saved without an ID are agent-wide. No chat history or automatic memory extraction is implied. [Scope examples and inheritance](docs/context.md#scoped-data).

## Search Knowledge

Add documents in the cabinet and explicitly connect the Space documents an agent needs. Then opt in on a call:

```js
const result = await agent.extract(
  'Within how many days can unused goods be returned?',
  { days: 'number' },
  { knowledge: true }
);
```

All four operations accept the same option. Use `{ knowledge: { query: 'return window and exceptions' } }` for an explicit search. `result.knowledge` describes the selected evidence; `result.knowledgeUsage` counts search embeddings separately from generation `usage`. [Knowledge guide](docs/knowledge.md).

## Use a local model

No account or key is needed for a local agent:

```sh
ollama pull qwen2.5:3b-instruct
```

```js
const agent = await NullProtocol.create({
  provider: 'ollama',
  model: 'qwen2.5:3b-instruct',
  instructions: 'Read orders. Use only facts in the supplied text.',
  timeout: 120000
});
```

Use the same four operations. Without a Space key, settings, context and notes live in your process and nothing is sent to NullProtocol. You can also [connect your own model provider](docs/providers.md). Local and external providers run without a Space key; saved agents and hosted telemetry use NullProtocol models.

## Examples and reference

- [Runnable examples](examples/README.md) — saved/local agents, message and catalogue actions, invoice, refund and SLA workflows.
- [API reference](docs/operations.md) — options, results, errors and action handlers.
- [Actions](docs/actions.md) · [Context and scopes](docs/context.md) · [Knowledge](docs/knowledge.md).
- [Models and credentials](docs/providers.md) — NullProtocol, Ollama, OpenAI, Anthropic and compatible servers.
- [Reference texts](docs/documents.md) — versions, budgets and History.
- [HTTP API](docs/http.md) — call a saved agent without the JavaScript SDK.
- [Changelog](CHANGELOG.md) · [Benchmark](bench/README.md)

## Development

```sh
npm ci
npm run validate
```

Version 3 removes the default `chat` handler: applications register executable actions explicitly. The examples also work with SDK 2.3 when those handlers are registered. See the [migration guide](docs/actions.md#upgrading-from-sdk-23) and [3.0 changes](CHANGELOG.md#300--2026-11-06).

## License

MIT
