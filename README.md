<img src="assets/nullprotocol.png" alt="NullProtocol" width="88" height="88" />

# NullProtocol

Give an AI agent a focused job. Extract typed data, summarize text, check an answer or choose an action. Manage its instructions and context in the [cabinet](https://app.nullprotocol.ai), and see the input, result and token usage of each operation.

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

`decide` chooses an action. To run application code, register a handler and pass the decision to `agent.execute(decision)`. See [actions and execution](docs/operations.md#actions).

## Give it the right context

```js
// Included in every operation.
await agent.context.set('shop', { currency: 'EUR', returnDays: 30 });

// Included only when the operation asks for it.
await agent.context.set('order', { id: 42, delivered: true }, { inclusion: 'selected' });
const result = await agent.extract('Read the order ID and shop currency.', { orderId: 'number', currency: 'string' }, {
  contextKeys: ['order']
});

// A short saved fact, included in every operation.
await agent.memory.add('The warehouse ships on weekdays.');
```

Reference texts added in the cabinet are included automatically. History keeps their revisions, so you can see the text used by an earlier operation after an edit. [Context, notes and customer data](docs/context.md).

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

Use the same four operations. Without a Space key, settings, context and notes live in your process and nothing is sent to NullProtocol. You can also [connect your own model provider](docs/providers.md).

## Examples and reference

- [Runnable examples](examples/README.md) — saved and local agents, then invoice, refund and SLA workflows.
- [API reference](docs/operations.md) — options, results, errors and action handlers.
- [Models and credentials](docs/providers.md) — NullProtocol, Ollama, OpenAI, Anthropic and compatible servers.
- [Reference texts](docs/documents.md) — versions, budgets and History.
- [HTTP API](docs/http.md) — call a saved agent without the JavaScript SDK.
- [Changelog](CHANGELOG.md) · [Benchmark](bench/README.md)

## Development

```sh
npm ci
npm run validate
```

## License

MIT
