import { NullProtocol } from 'nullprotocol';

// A local model through Ollama. Any provider works: see docs/operations.md.
export const ai = new NullProtocol({
  provider: 'openai-compatible',
  baseURL: process.env.NULLPROTOCOL_MODEL_URL || 'http://localhost:11434/v1',
  model: process.env.NULLPROTOCOL_MODEL || 'qwen2.5:3b-instruct',
  temperature: 0,
  timeout: 120000 // a local model can take longer than the 30-second default
});
