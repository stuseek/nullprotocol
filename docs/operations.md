# Operations and configuration

With a local model server you need no account and no key. Save this example as `example.mjs`:

```js
import { NullProtocol } from 'nullprotocol';

const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct'
});

const result = await ai.extract('Order 42: two blue mugs', {
  orderId: 'number',
  quantity: 'number',
  item: 'string'
});
if (result.success) console.log(result.data);
else console.error(result.error); // ask again, use a stronger model, or send for review
```

For Ollama, pull the model and run the example:

```sh
ollama pull qwen2.5:3b-instruct
node example.mjs
```

The same client with a cloud model:

```js
const openai = new NullProtocol({ provider: 'openai', model: 'gpt-4.1-mini' }); // reads OPENAI_API_KEY
const claude = new NullProtocol({ provider: 'anthropic', model: 'claude-sonnet-5' }); // reads ANTHROPIC_API_KEY
```

With `openai`, every request sends `temperature` and `max_tokens`. OpenAI reasoning models that reject these parameters, such as `gpt-5-mini`, are not supported by this client yet; use a chat model such as `gpt-4.1-mini`.

Any call can use another model of the same provider by its name: `ai.extract(text, schema, { model: 'qwen2.5:7b-instruct' })`.

| `provider` | Calls | Key |
| --- | --- | --- |
| `'openai-compatible'` | Any server that speaks the OpenAI chat API at `baseURL`: Ollama, LM Studio, vLLM, a proxy | `apiKey` if the server needs one; cloud key variables are never read |
| `'openai'` | The OpenAI API | `apiKey`, or `OPENAI_API_KEY` |
| `'anthropic'` | The Anthropic Messages API | `apiKey`, or `ANTHROPIC_API_KEY`; needs `@anthropic-ai/sdk` |

| Constructor field | What to put | Required | Default |
| --- | --- | --- | --- |
| `provider` | One of the values above | Yes | — |
| `model` | The model name the provider knows, such as `qwen2.5:3b-instruct` | Yes | — |
| `baseURL` | Server address, such as `http://localhost:11434/v1` | With `openai-compatible` only | — |
| `apiKey` | The model API key | For `openai` and `anthropic`, unless set in the environment | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |
| `temperature` | Sampling temperature | No | `0.3` (not sent to Claude 4.7 and later) |
| `maxTokens` | Reply length limit | No | `1000` |
| `timeout` | Milliseconds per model request | No | `30000` |
| `retry` | `{ maxRetries }` for transient errors | No | `{ maxRetries: 2 }` |
| `repairAttempts` | Extra turns to fix an unusable reply, 0 to 3 | No | `1` |
| `basePrompt` | Instructions added to every call | No | — |
| `trackHistory` | Keep `chat` history in this instance | No | `false` |
| `maxContextLength` | Character budget for a request | No | none |
| `telemetry` | `true` to send usage metadata, see [Optional telemetry](dashboard.md#optional-telemetry) | No | `false` |
| `telemetryEndpoint` | `https://api.nullprotocol.ai` for the hosted API | With `telemetry` | — |
| `telemetryKey` | Space ingest key from the cabinet | With `telemetry` | — |

Settings come from a config file (`nullprotocol.config.json`, or `configFile`), then from options, which win field by field. A configuration error, such as a missing `model` or a `baseURL` with `openai`, is thrown by the constructor before any request. `provider` cannot be combined with the engines form; with `provider` set, the engines form's environment variables are not used.

| Operation | Result | Local check |
| --- | --- | --- |
| `extract(data, schema)` | Structured data | JSON Schema validation |
| `validate(criteria, subject)` | Score and reasoning | Score and confidence ranges, recommendation enum |
| `summarize(content)` | Summary and key points | Response shape, length, confidence range |
| `decide(context, actions)` | Selected action | Membership in the allowed list, confidence range |
| `chat(prompt)` | Text or tool calls | Nonempty response, tool allowlist |

Every operation takes these in its options:

| Option | What to put | Default |
| --- | --- | --- |
| `model` | Another model name of the same provider | The constructor's `model` |
| `temperature` | Sampling temperature for this call | The constructor's `temperature` |
| `maxTokens` | Reply length limit for this call | The constructor's `maxTokens` |
| `additionalContext` | Extra text or an object sent with this call | none |

The rest belong to one operation:

| Operation | Its own options |
| --- | --- |
| `extract` | `repairAttempts`, `validate` (include the validation details in the result) |
| `validate` | none; the score is the model's judgment, checked only for range and shape |
| `summarize` | `maxLength` (characters, default 200), `focus` |
| `decide` | `guard`, `guardTimeoutMs`, `repairAttempts` |
| `chat` | `systemPrompt`, `tools` with `onToolCall`, `stream`, `collect`, `trackHistory` |

Operations return `{ success, ... }`; model and validation failures are `{ success: false, error }`, so check `success` before acting. A refused, truncated or content-filtered reply is a failure, never partial text. Validation catches malformed output; it cannot prove the extracted facts are true.

When `extract` gets invalid JSON or a schema mismatch, or `decide` gets an action outside the list, the model is shown the exact problem and asked once more. Set `repairAttempts` (0 to 3, default 1) on the constructor or per call. Results report `attempts` and `repaired`. A repair fixes the reply's form, not its facts.

### Extraction schemas

A schema is shorthand or JSON Schema:

```js
// Shorthand: every key is a required field, so this has a field named "items".
await ai.extract(text, { vendor: 'string', items: 'string[]' });

// JSON Schema is used as is.
await ai.extract(text, {
  type: 'object',
  properties: { id: { type: 'string' }, note: { type: 'string' } },
  required: ['id']
});

// A nested object made only of schema keywords is JSON Schema: here address is a string.
await ai.extract(text, { address: { type: 'string' } });
```

To name a single nested field `type`, write that object as JSON Schema. An invalid schema fails before the model is called.

### Decisions with hard rules

The action list checks the shape of a model's choice, not whether it is right. For rules, pass an application-owned `guard`; only `true` accepts the decision, and a rejected one has `action: null` and is not retried.

```js
const metrics = { errorRatePercent: 35 }; // from your monitoring, not from model input
const decision = await ai.decide({ ...metrics, logLine }, ['inspect_logs', 'monitor'], {
  guard: ({ action }) => action === (metrics.errorRatePercent > 20 ? 'inspect_logs' : 'monitor')
});
```

Asynchronous guards have a 30-second deadline (`guardTimeoutMs`) and receive an abort `signal`.

### Tool calls and actions

```js
const response = await ai.chat('Look up order 42', {
  tools: [{
    name: 'get_order',
    description: 'Read an order by ID',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  }],
  onToolCall: async (name, params) => orderStore.get(params.id)
});
```

Only offered tool names reach `onToolCall`, for at most ten rounds. Retries apply to each model request, so a transient error does not rerun a tool. Validate parameters and permissions in your callback before side effects.

Registered actions can require confirmation from your application:

```js
ai.registerAction('send_email', sendEmail, { requiresConfirmation: true });
await ai.execute(decision, { confirm: async (action, parameters) => askUserToApprove(action, parameters) });
```

Without an approving callback, `execute` throws `ConfirmationRequiredError` and the handler is not called.

### History and context size

With `trackHistory: true`, `chat` keeps history per instance, so use one instance per conversation. `{ stream: true }` returns an async generator; add `collect: true` for a normal result. `maxContextLength` (characters) drops the oldest chat turns before a request and fails if the system text and current input alone do not fit.

Claude 4.7 and later accept no sampling parameters, so `temperature` is sent only to older Claude models.

### Engines form

Configurations written for `nullprotocol@1.0.0` keep working without `provider`: `engines` holds a key per engine (`{ openai, anthropic }`), `defaultEngine` picks one, `openaiBaseURL` points the OpenAI engine at another server, and `models` sets each engine's model (default `gpt-4` and `claude-sonnet-5`) plus aliases you can pass as a per-call `model`. In this form the environment can also set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_DEFAULT_ENGINE`, `AI_MODEL_OPENAI`, `AI_MODEL_ANTHROPIC` and `NULLPROTOCOL_OPENAI_BASE_URL`, and `OPENAI_API_KEY` is sent to `openaiBaseURL` when no other key is given.

### Checking a local model

```sh
NULLPROTOCOL_MODEL=qwen2.5:7b-instruct npm run smoke:local
```

This calls Ollama's OpenAI-compatible endpoint once per operation and once with a tool. It checks format, not model quality. `npm test` never calls paid model APIs; set `NULLPROTOCOL_LIVE_TESTS=1` with provider keys to run the live suite. A [48-task workflow benchmark](../bench/README.md) compares one direct prompt with a flow built on `extract`, on local 3B and 7B models and a hosted one, with the [raw results](../bench/published).
