![NullProtocol](assets/nullprotocol.svg)

# NullProtocol

Build on inexpensive or local language models without trusting every byte they return. NullProtocol adds structured output checks, bounded tool calls, retries, timeouts, and a small HTTP adapter to OpenAI and Anthropic SDKs.

[![npm](https://img.shields.io/npm/v/nullprotocol?label=npm)](https://www.npmjs.com/package/nullprotocol) [![CI](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml/badge.svg)](https://github.com/stuseek/nullprotocol/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-205c42)](LICENSE)

The library is MIT licensed. It runs without a NullProtocol account or telemetry. A hosted telemetry product is planned; there is no hosted dashboard to sign up for yet.

## Install

```sh
npm install nullprotocol openai
```

Node.js 18 or newer is required. Install `@anthropic-ai/sdk` instead of `openai` if you use Anthropic.

## Start with a small or local model

Point the OpenAI client at any compatible endpoint. The example URL and model name below are placeholders for your own server.

```js
const { NullProtocol } = require('nullprotocol');

const ai = new NullProtocol({
  engines: { openai: process.env.MODEL_API_KEY || 'local' },
  openaiBaseURL: process.env.MODEL_BASE_URL || 'http://127.0.0.1:1234/v1',
  models: { openai: process.env.MODEL_NAME || 'your-model' },
  retry: { maxRetries: 2 },
  timeout: 20_000
});

const result = await ai.extract('Order 42: two blue mugs', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});

if (!result.success) {
  // Ask again, route to a stronger model, or send for review.
  console.error(result.error);
} else {
  console.log(result.data);
}
```

`extract` checks the response with a local JSON Schema validator. The shorthand above requires every field and checks its type. You can pass a full JSON Schema object when you need optional fields or stricter rules. Validation catches malformed output; it cannot prove that the extracted facts are true.

## What it does

| Operation | Result | Local check |
| --- | --- | --- |
| `extract(data, schema)` | Structured data | JSON Schema validation |
| `validate(criteria, subject)` | Score and reasoning | Score range and response shape |
| `summarize(content)` | Summary and key points | Response shape and length |
| `decide(context, actions)` | Selected action | Membership in the allowed list |
| `chat(prompt)` | Text or tool calls | Nonempty response, tool allowlist |

Every operation returns `{ success, ... }`. Model and validation failures appear as `{ success: false, error }`. Handle those results before acting on them.

### Model choice

```js
const ai = new NullProtocol({
  engines: { openai: process.env.OPENAI_API_KEY },
  models: {
    openai: 'your-default-model',
    cheap: 'your-small-model',
    fallback: 'your-stronger-model'
  }
});

const first = await ai.extract(text, schema, { model: 'cheap' });
const result = first.success ? first : await ai.extract(text, schema, { model: 'fallback' });
```

Aliases select a model; NullProtocol does not automatically choose the cheapest model or fall back after a bad answer. That policy stays in your application.

### Tool calls

```js
const response = await ai.chat('Look up order 42', {
  tools: [{
    name: 'get_order',
    description: 'Read an order by ID',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id']
    }
  }],
  onToolCall: async (name, params) => {
    if (name === 'get_order') return orderStore.get(params.id);
    throw new Error('Unknown tool');
  }
});
```

Only offered tool names reach `onToolCall`. The model can request at most ten rounds. Retries apply to each model request, so a transient error after a tool call does not rerun the tool callback. Your callback should still validate parameters and permissions before side effects.

For registered actions, use `requiresConfirmation` and supply a confirmation callback from your application:

```js
ai.registerAction('send_email', sendEmail, { requiresConfirmation: true });
await ai.execute(decision, {
  confirm: async (action, parameters) => askUserToApprove(action, parameters)
});
```

Without an approving callback, execution throws `ConfirmationRequiredError` and the handler is not called.

### Example: a game NPC

Keep an instance for each active conversation. Pass game state as context, and expose only the actions that NPC may use.

```js
const npc = new NullProtocol({
  engines: { openai: 'local' },
  openaiBaseURL: 'http://127.0.0.1:1234/v1',
  models: { openai: 'your-model' },
  basePrompt: 'You are Mira, a merchant in a fantasy game.',
  trackHistory: true
});

npc.addContext('shop', { potions: 3, price: 5 });
const reply = await npc.chat('Do you have a potion?', {
  tools: [{ name: 'check_stock', description: 'Read the current shop stock' }],
  onToolCall: async name => {
    if (name === 'check_stock') return game.shop.stock();
    throw new Error('Unknown tool');
  }
});

if (reply.success) showDialogue(reply.message);
```

The game owns inventory, permissions, and save data. NullProtocol helps the model talk to that code and checks the results it can check.

### Conversation and streaming

```js
const ai = new NullProtocol({
  engines: { openai: process.env.OPENAI_API_KEY },
  trackHistory: true
});

await ai.chat('My name is Sam.');
const reply = await ai.chat('What is my name?');

const stream = await ai.chat('Explain this code', { stream: true });
for await (const chunk of stream) process.stdout.write(chunk);
```

History is opt in and applies to `chat` only. For separate users or conversations, create separate instances. Streaming returns an async generator; `{ stream: true, collect: true }` returns a normal result.

### Bound the context

Set `maxContextLength` in characters when using a model with a small context window. NullProtocol keeps the system text and current input, then applies a sliding window to older chat turns. You can change the budget while the agent runs.

```js
const ai = new NullProtocol({
  engines: { openai: 'local' },
  openaiBaseURL: 'http://127.0.0.1:1234/v1',
  models: { openai: 'your-model' },
  trackHistory: true,
  maxContextLength: 12_000
});

ai.setMaxContextLength(8_000);
```

If the system text, current input, or tool definitions alone exceed the budget, the request fails. The count is an approximation based on characters, not the provider's tokenizer. `maxHistoryTokens` remains a separate rough cap for stored chat history. Automatic model based compaction is not part of this release.

## Optional telemetry

Telemetry is off by default. With `telemetry: true`, an HTTPS endpoint, and a key, the client sends operation metadata and model token usage when the provider returns it. It excludes prompts, responses, tool parameters, and credentials from event bodies. The key goes in the authorization header. The client buffers up to 1,000 events and uses a short network timeout.

```js
const ai = new NullProtocol({
  engines: { openai: process.env.OPENAI_API_KEY },
  telemetry: true,
  telemetryEndpoint: process.env.TELEMETRY_ENDPOINT,
  telemetryKey: process.env.TELEMETRY_KEY
});

// Flush queued events before shutdown if your process needs guaranteed delivery.
await ai.telemetry?.destroy();
```

No telemetry endpoint is bundled with the library. The planned paid service is separate from the free runtime.

## HTTP adapter

The server binds to `127.0.0.1` by default, requires a Bearer token, limits request bodies to 1 MiB, and keeps request state separate.

```js
const { serve } = require('nullprotocol');

serve({
  apiKey: process.env.NULLPROTOCOL_API_KEY,
  engines: { openai: process.env.OPENAI_API_KEY },
  port: 3000
});
```

Routes: `POST /extract`, `/validate`, `/summarize`, `/decide`, `/chat`, and `GET /health`. Add `cors` only when browser access is needed. Set `host: '0.0.0.0'` explicitly to expose the server outside localhost.

## Moving from `@stuseek/ai-toolkit`

Install `nullprotocol`, change the package import, and use `NullProtocol` in new code. `AIToolkit` remains an export alias. Existing deployments pinned to `@stuseek/ai-toolkit` keep using that package until migrated. The old token only cloud mode never had a working backend and now reports a clear configuration error.

## License

MIT. See [LICENSE](LICENSE).
