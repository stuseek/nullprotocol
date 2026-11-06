# Examples

Run these from the repository after `npm ci`. In your own project, install `nullprotocol` and copy the example you need. Node.js 18 or newer; no build step.

## Saved agent

Create an agent in the cabinet and choose a NullProtocol model. Put its Space SDK key and agent ID in your environment:

```sh
export NULLPROTOCOL_KEY='your-space-sdk-key'
export NULLPROTOCOL_AGENT_ID='order-reader'
node examples/saved.mjs
```

[saved.mjs](saved.mjs) loads the agent, extracts three order fields and prints its result and reported tokens. NullProtocol models require enabled team access and credit. The Space SDK key also authorizes the hosted model call; no upstream provider key is needed. Your own providers run as standalone agents without a Space key; see [provider setup](../docs/providers.md).

## Local agent

```sh
ollama pull qwen2.5:3b-instruct
node examples/local.mjs
```

[local.mjs](local.mjs) runs the same extraction locally, without an account or key. `NULLPROTOCOL_MODEL` changes the model and `NULLPROTOCOL_MODEL_URL` changes the Ollama address.

## Workflows

[Invoice, refund and SLA examples](flows/README.md) combine extraction with calculations and rules in application code.

## Message and catalogue actions

```sh
node examples/actions.mjs 'Hello!'
node examples/actions.mjs 'Find a blue mug under 20 EUR.'
```

[actions.mjs](actions.mjs) defaults to local Ollama, with the same model/URL environment variables as above. With both `NULLPROTOCOL_KEY` and `NULLPROTOCOL_AGENT_ID`, it loads a saved agent instead; optional `NULLPROTOCOL_SCOPE_ID` selects any saved data scope using the SDK's `conversation` field.

The application registers `send_message` and `search_catalog`. A greeting returns the text prepared during `decide`; a product request searches the small catalogue in the file. `execute` does not make another model call. The example writes results to stdout, not to a real messaging service. [Actions guide](../docs/actions.md).

- `node examples/knowledge.mjs` stages a temporary shared Knowledge source, checks preparation, connects it and searches it; requires a saved support agent and a Space key. It removes its own source afterward.

`photos.mjs` reads a reachable photo URL through a saved Vision agent. Set `NULLPROTOCOL_KEY`, optionally `AGENT_ID` and `PHOTO_URL`; create the agent in the dashboard first. See [photo input](../docs/operations.md#photo-input).
