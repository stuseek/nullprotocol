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
// `observe(record)` receives each compaction request and reply as sent and
// received, with its duration; the request path itself is unchanged.
export async function managedAgents(model, agents, { observe } = {}) {
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
    credentials: { model: { provider: 'local', baseURL: modelURL } },
    ...(observe
      ? {
          modelFetchImpl: async (url, init) => {
            const started = Date.now();
            const response = await fetch(url, init);
            const request = JSON.parse(init.body);
            if (!String(request.messages?.[0]?.content).startsWith('Compact the supplied')) {
              return response;
            }
            const text = await response.clone().text();
            observe({ request, status: response.status, text, ms: Date.now() - started });
            return response;
          }
        }
      : {})
  });
  await executor.start();
  return {
    async turn(name, text, conversation) {
      const agent = client.agent(ids[name]);
      const started = Date.now();
      const run = await agent.run(text, { conversation });
      const seen = Date.now();
      const { steps } = await agent.listSteps(run.id);
      const apiCallMs = Date.now() - seen;
      return {
        answer: run.status === 'succeeded' ? (run.output?.text ?? null) : null,
        errorCode: run.errorCode ?? null,
        runStatus: run.status,
        usage: run.usage ?? null,
        ms: seen - started,
        latency: latency(run, steps, started, seen, apiCallMs),
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

// Where a managed turn's time went. The API runs in this process, so server
// timestamps and Date.now() share a clock.
function latency(run, steps, started, seen, apiCallMs) {
  const at = value => (value ? Date.parse(value) : null);
  const created = at(run.createdAt);
  const claimed = at(run.startedAt);
  const finished = at(run.finishedAt);
  const duration = kind =>
    steps
      .filter(step => step.kind === kind && step.finishedAt)
      .reduce((total, step) => total + at(step.finishedAt) - at(step.startedAt), 0);
  const execution = claimed && finished ? finished - claimed : null;
  const model = duration('model');
  const action = duration('action');
  const compaction = duration('compaction');
  return {
    createMs: created ? created - started : null,
    queueMs: created && claimed ? claimed - created : null,
    executionMs: execution,
    modelMs: model,
    actionMs: action,
    compactionMs: compaction,
    // Step writes, lease, context and commit inside the run.
    platformMs: execution === null ? null : execution - model - action - compaction,
    clientWaitMs: finished ? seen - finished : null,
    apiCallMs
  };
}

// Failed runs stay in every denominator; this only says what kind of failure.
const infrastructure = new Set([
  'space_busy',
  'platform_unavailable',
  'platform_timeout',
  'model_error',
  'timeout',
  'executor_lost',
  'run_wait_timeout',
  'runtime_offline',
  'unsupported'
]);
export function failureClass(errorCode) {
  if (!errorCode) return null;
  if (errorCode === 'invalid_model_response') return 'parser';
  if (errorCode === 'tool_limit') return 'limit';
  return infrastructure.has(errorCode) ? 'infrastructure' : 'other';
}

// Runs only from committed source, and records exactly which.
export function source(root, git) {
  const paths = ['src', 'bench/value', 'scripts'];
  if (git(['status', '--porcelain', '--', ...paths])) {
    throw new Error(`Commit ${paths.join(', ')} before a pilot run`);
  }
  return {
    commit: git(['rev-parse', 'HEAD']),
    trees: Object.fromEntries(paths.map(item => [item, git(['rev-parse', `HEAD:${item}`])]))
  };
}
