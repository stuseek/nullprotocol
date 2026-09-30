// Model access shared by the pilot runners: a direct OpenAI-compatible call
// with the executor's generation settings, and a managed Agent on an
// in-process API.
import { createRequire } from 'node:module';
import { localSpace } from '../../scripts/local-space.mjs';

const require = createRequire(import.meta.url);
const { NullProtocolClient, ManagedExecutor } = require('../../src');

export const modelURL = process.env.MODEL_BASE_URL || 'http://127.0.0.1:11434/v1';
// managed-model.requestBody sends max_tokens 1024 and nothing else.
export const generation = {
  max_tokens: 1024,
  temperature: 'provider default',
  generationSeed: null
};

export async function chat(model, messages, tools) {
  const body = JSON.stringify({ model, messages, max_tokens: 1024, ...(tools ? { tools } : {}) });
  const started = Date.now();
  const response = await fetch(`${modelURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message || `HTTP ${response.status}`), {
      code: response.status === 400 ? 'unsupported' : 'model_error'
    });
  }
  return {
    message: data.choices[0].message,
    usage: data.usage,
    ms: Date.now() - started,
    requestBytes: Buffer.byteLength(body)
  };
}

// One Space per model with one Agent per entry in `agents`
// ({ name, instructions, actions }); free Spaces allow three.
export async function managedAgents(model, agents) {
  const space = await localSpace([
    'templates:write',
    'agents:write',
    'agents:read',
    'runs:create',
    'runs:read',
    'conversations:read'
  ]);
  const client = new NullProtocolClient({ spaceKey: space.appKey, endpoint: space.endpoint });
  const ids = {};
  for (const { name, instructions, actions = [] } of agents) {
    const { template } = await client.templates.create({
      name: `${name} ${model}`,
      config: {
        instructions,
        model: { provider: 'local', model, credentialRef: 'model' },
        actions,
        memory: { mode: 'conversation' }
      }
    });
    ids[name] = (await client.agents.create({ templateId: template.id })).agent.id;
  }
  const executor = new ManagedExecutor({
    executorKey: space.executorKey,
    endpoint: space.endpoint,
    agentIds: Object.values(ids),
    actions: agents.flatMap(agent => agent.actions || []),
    credentials: { model: { provider: 'local', baseURL: modelURL } }
  });
  await executor.start();
  return {
    async turn(name, text, conversation) {
      const agent = client.agent(ids[name]);
      const started = Date.now();
      const run = await agent.run(text, { conversation });
      const { steps } = await agent.listSteps(run.id);
      return {
        answer: run.status === 'succeeded' ? (run.output?.text ?? null) : null,
        errorCode: run.errorCode ?? null,
        runStatus: run.status,
        usage: run.usage ?? null,
        ms: Date.now() - started,
        toolErrors: steps
          .filter(step => step.status === 'failed' || step.payload?.allowed === false)
          .map(step => step.payload?.errorCode || step.payload?.reasonCode || step.kind),
        steps
      };
    },
    conversation: (name, key) => client.agent(ids[name]).conversations.get(key),
    async close() {
      await executor.stop();
      await space.cleanup();
    }
  };
}
