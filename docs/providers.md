# Models and credentials

## Supported providers

| `provider` | Calls | Credentials |
| --- | --- | --- |
| `nullprotocol` | NullProtocol’s model gateway | `key`, the SDK key of its Space; enabled team access and credit |
| `openai` | the OpenAI chat completions API | `apiKey` or `OPENAI_API_KEY` |
| `anthropic` | the Anthropic messages API | `apiKey` or `ANTHROPIC_API_KEY` |
| `ollama` | Ollama's own chat API | `baseURL` if it is not `http://localhost:11434` |
| `openai-compatible` | any server with the OpenAI chat API: vLLM, LM Studio, Mistral, and others | `baseURL`, and `apiKey` if the server needs one |

A request that does not fit the model's window must fail, not be cut down. `ollama` asks Ollama to refuse it, and the operation fails with `model_context_too_large` and both numbers. Ollama's OpenAI-compatible address (`/v1`) cuts the same request down silently and answers from what is left, so use `ollama` for Ollama. Whether another OpenAI-compatible server refuses or cuts is up to that server; the SDK cannot tell.



## Run with your own provider

```js
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.create({
  provider: 'openai',
  model: 'gpt-4.1-mini',
  instructions: 'Extract facts from the supplied text. Do not invent missing values.'
});
```

Set `OPENAI_API_KEY` in your application environment. For Anthropic, use `provider: 'anthropic'`, your model's exact API name and `ANTHROPIC_API_KEY`. These keys are read by the application, not stored in the cabinet.

For a server speaking the OpenAI chat API:

```js
const agent = await NullProtocol.create({
  provider: 'openai-compatible',
  model: 'your-model',
  baseURL: 'http://localhost:8000/v1'
});
```

## Saved agents with your own provider

Pass a Space SDK `key` to `create` to save the agent. Load it later with `NullProtocol.load({ key, agentId })`. The agent's model and instructions are read from its saved settings; provider credentials come from your application.

A process that may be asked to use several providers can supply their credentials together:

```js
const agent = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: 'support',
  credentials: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    'openai-compatible': { baseURL: 'http://localhost:8000/v1' }
  }
});
```

If credentials for the saved provider are unavailable, an operation returns `model_unavailable`. A model change in the cabinet applies to the next operation.

## Request limits

`timeout` is in milliseconds (30000 by default). A slow local model may need `timeout: 120000`. `maxTokens` limits the generated output (1000 by default).

`maxPromptBytes` limits the serialized request body (131072 bytes by default). It does not measure the model's token window. Ollama can reject a request that fits that byte limit but exceeds its own window. See [all call options](operations.md#creating-and-loading).

