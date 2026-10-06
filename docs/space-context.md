# Shared Space context

Agents in one Space can share small versioned JSON documents through a separate context key, independent of telemetry and your model provider:

```js
const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b-instruct',
  spaceContextKey: process.env.NULLPROTOCOL_SPACE_CONTEXT_KEY,
  spaceContextEndpoint: 'https://api.nullprotocol.ai'
});
const current = await ai.spaceContext.get('ops', 'last-check');
await ai.spaceContext.put('ops', 'last-check', { status: 'ok' }, {
  ifVersion: current?.version ?? null,
  ttlSeconds: 3600
});
```

`ifVersion: null` creates a document; a stale version throws `SpaceContextError` with `status: 409`. A Space holds up to 100 documents of 4 KiB each. Values are never added to prompts automatically, and the API stores them until deletion or expiry, so avoid secrets and personal data.
