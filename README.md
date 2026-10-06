<img src="assets/nullprotocol.png" alt="NullProtocol" width="88" height="88" />

# NullProtocol

[![npm](https://img.shields.io/npm/v/nullprotocol?color=205c42)](https://www.npmjs.com/package/nullprotocol) [![CI](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml/badge.svg)](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-205c42)](LICENSE)

Build focused AI agents around your data, rules and models. NullProtocol is a Node.js SDK with five small operations (`extract`, `validate`, `summarize`, `decide`, `chat`) that return checked results your code can act on. It works with OpenAI, Anthropic and any OpenAI-compatible server, including a local model.

- **Checked output.** `extract` validates the reply against a JSON Schema, and `decide` only returns an action from your list.
- **Your rules in code.** A `guard` you write accepts or refuses each decision before anything runs.
- **Small models do real work.** Let the model read and your code compute: see the [benchmark](#benchmark).
- **An optional dashboard.** See your calls in Activity and pause or stop an agent, without sending prompts or replies.

[Website](https://nullprotocol.ai) · [Dashboard](https://app.nullprotocol.ai) · [Docs](#documentation)

## Install

```sh
npm install nullprotocol 'openai@^4.104.0'
```

Node.js 18 or newer. If your project already has `openai` (4 to 7), `npm install nullprotocol` is enough. For Anthropic, install `@anthropic-ai/sdk` instead.

## Quick start

With a local model you need no account and no key:

```sh
ollama pull qwen2.5:3b-instruct
```

```js
import { NullProtocol } from 'nullprotocol';

const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  timeout: 120000 // a local model can take longer than the 30-second default
});

const order = await ai.extract('Order 42: two blue mugs', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});

if (order.success) console.log(order.data); // { orderId: 42, quantity: 2, item: 'blue mugs' }
else console.error(order.error); // ask again, use a stronger model, or send for review
```

The same code runs on a hosted model:

```js
const openai = new NullProtocol({ provider: 'openai', model: 'gpt-4.1-mini' }); // reads OPENAI_API_KEY
const claude = new NullProtocol({ provider: 'anthropic', model: 'claude-sonnet-5' }); // reads ANTHROPIC_API_KEY
```

## Operations

| Operation | Returns | Checked locally |
| --- | --- | --- |
| `extract(data, schema)` | Structured data | JSON Schema |
| `decide(context, actions)` | One action from your list | The list, then your `guard` |
| `validate(criteria, subject)` | A score and reasoning | Ranges and shape |
| `summarize(content)` | A summary and key points | Shape and length |
| `chat(prompt)` | Text or tool calls | Tool allowlist |

Every operation returns `{ success, ... }`. A malformed, refused or truncated reply is `{ success: false, error }`, never partial data, so check `success` before acting. The checks catch malformed output; they cannot prove a fact is true.

### Rules in code

The model proposes, your code decides:

```js
const metrics = { errorRatePercent: 35 }; // from your monitoring, not from the model
const decision = await ai.decide({ ...metrics, logLine }, ['inspect_logs', 'monitor'], {
  guard: ({ action }) => action === (metrics.errorRatePercent > 20 ? 'inspect_logs' : 'monitor')
});
```

### Tools

```js
const reply = await ai.chat('Look up order 42', {
  tools: [{
    name: 'get_order',
    description: 'Read an order by ID',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  }],
  onToolCall: async (name, params) => orderStore.get(params.id)
});
```

Schemas, options, retries, streaming and history are in [Operations and configuration](docs/operations.md).

## Benchmark

48 back-office tasks (invoice totals, refunds under a policy, SLA deadlines, ticket queues), asked three ways. In the flow, `extract` reads the text and code does the arithmetic and the rules.

| Model | Direct prompt | Direct, with reasoning | NullProtocol flow |
| --- | ---: | ---: | ---: |
| Qwen 2.5 3B, local | 3/48 | 10/48 | 47/48 |
| Qwen 2.5 7B, local | 9/48 | 18/48 | 48/48 |
| Mistral Large 3 | 13/48 | 44/48 | 48/48 |

One run per task on synthetic tasks. [Tasks, method, limits and raw results](bench/README.md).

A flow is short. Save this as `refund.mjs` and run it with `node refund.mjs`: the model says what state the item is in, and the policy stays in your code.

```js
import { NullProtocol } from 'nullprotocol';

const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  timeout: 120000
});

const order = { category: 'kitchen', price: 120, delivered: '2026-09-12' }; // from your order system
const today = '2026-10-06';
const message = 'Order 6642: the blender came on 12 September. I used it twice and do not like it. Refund please.';

const read = await ai.extract(message, {
  type: 'object',
  required: ['evidence', 'condition'],
  properties: {
    evidence: { type: 'string', description: "The customer's exact words about the state of the item. An empty string if the message does not say." },
    condition: { type: 'string', enum: ['untouched', 'used', 'unknown'], description: 'unknown: the message does not say; do not guess.' }
  }
});

// 30 days to return, 15% fee on a used item, above $200 a person decides.
// A failed read or an unknown state also goes to a person.
function decide() {
  if (!read.success || read.data.condition === 'unknown' || !read.data.evidence.trim()) return { action: 'escalate' };
  if ((Date.parse(today) - Date.parse(order.delivered)) / 86400000 > 30) return { action: 'deny' };
  const amount = read.data.condition === 'used' ? order.price * 0.85 : order.price;
  return amount > 200 ? { action: 'escalate' } : { action: 'refund', amount };
}

console.log(read.data); // { evidence: 'I used it twice and do not like it.', condition: 'used' }
console.log(decide()); // { action: 'refund', amount: 102 }
```

Three runnable flows, each one command on a local model: [examples/flows](examples/flows/README.md).

## Connect to the dashboard

Optional. Give each AI step an `agentId` and connect it to a Space in the [dashboard](https://app.nullprotocol.ai): its calls appear in Activity, and you can pause or stop it. Only metadata is sent (model, duration, token counts, outcome), never prompts or replies.

### An existing OpenAI client

Keep your requests, tool loop and error handling:

```js
import OpenAI from 'openai';
import { connectOpenAI } from 'nullprotocol/openai';

const support = connectOpenAI(new OpenAI(), {
  agentId: 'support',
  telemetryKey: process.env.NULLPROTOCOL_TELEMETRY_KEY,
  telemetryEndpoint: 'https://api.nullprotocol.ai'
});

// In place of openai.chat.completions.create
const completion = await support.create({
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Where is order 58213?' }]
});
await support.close();
```

The SDK's own operations take the same settings on the constructor. Keys, events, streaming, and how pause and stop behave are in [Activity, telemetry and control](docs/dashboard.md).

### What needs an account

| Feature | Account | Key |
| --- | --- | --- |
| `extract`, `validate`, `summarize`, `decide`, `chat`, tools, guards | No | Only your model's key, if it needs one |
| `serveAgents`, `serve` and the CLI | No | Your own HTTP `apiKey` for callers |
| Telemetry | Yes | Space ingest key as `telemetryKey` |
| Runtime control (pause, resume, stop) | Yes | Runtime key as `runtimeKey` |
| Shared Space context | Yes | Space context key as `spaceContextKey` |
| Managed Agents | Yes, allowlisted team | App key for `NullProtocolClient`, executor key for `ManagedExecutor` |

## Managed Agents (allowlisted beta)

A Managed Agent keeps its instructions, actions, context and memory in a Space, and runs on an executor in your infrastructure that holds the model credentials. You start runs from your app, give each one its context, save and delete memory notes, and read every step afterwards.

```js
import { NullProtocolClient } from 'nullprotocol';

const client = new NullProtocolClient({ spaceKey: process.env.NULLPROTOCOL_APP_KEY });
const agent = client.agent(agentId);

await agent.memory.add({ text: 'Keep public APIs backward-compatible.' });
const run = await agent.run('Review this change', {
  context: { diff, apiContract },
  conversation: 'api-review'
});
```

Access requires an allowlisted team. Setup, the executor, what a run guarantees and the limits of memory are in [Managed Agents](docs/managed-agents.md); the quickest start is [examples/managed/starter](examples/managed/starter/README.md).

## Documentation

- [Operations and configuration](docs/operations.md): schemas, guards, tools, options, providers, history
- [Activity, telemetry and control](docs/dashboard.md): connecting a client, events, pause and stop
- [Managed Agents](docs/managed-agents.md) and the [upgrade guide](docs/upgrade-managed.md)
- [Named agents over HTTP](docs/http-server.md): `serveAgents`, sessions, the CLI
- [Shared Space context](docs/space-context.md)
- [Benchmark](bench/README.md) and [runnable flows](examples/flows/README.md)
- [Changelog](CHANGELOG.md)

Coming from `@stuseek/ai-toolkit`? Install this package and change the import; `AIToolkit` remains an export alias. The old token-only cloud mode reports a configuration error.

## Development

`npm run validate` runs lint, formatting and tests. `npm run test:managed-integration` checks the SDK against the API repository checked out next to this one (`../api`), using its separate `TEST_DATABASE_URL`; it refuses to run when that equals `DATABASE_URL`.

## License

MIT. See [LICENSE](LICENSE).
