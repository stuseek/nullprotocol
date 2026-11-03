# Examples

Run these from the repository after `npm ci`. In your own project, install `nullprotocol` and copy the example you need. Node.js 18 or newer; no build step.

## Saved agent

Create an agent in the cabinet and give it a NullProtocol model, or use a saved agent configured for your own provider. Put its Space SDK key and agent ID in your environment:

```sh
export NULLPROTOCOL_KEY='your-space-sdk-key'
export NULLPROTOCOL_AGENT_ID='order-reader'
node examples/saved.mjs
```

[saved.mjs](saved.mjs) loads the agent, extracts three order fields and prints its result and reported tokens. NullProtocol models require enabled team access and credit. Your own model needs its provider credentials in this process; [provider setup](../docs/providers.md).

## Local agent

```sh
ollama pull qwen2.5:3b-instruct
node examples/local.mjs
```

[local.mjs](local.mjs) runs the same extraction locally, without an account or key. `NULLPROTOCOL_MODEL` changes the model and `NULLPROTOCOL_MODEL_URL` changes the Ollama address.

## Workflows

[Invoice, refund and SLA examples](flows/README.md) combine extraction with calculations and rules in application code.
