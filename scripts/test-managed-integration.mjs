import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { NullProtocolClient, ManagedExecutor, defineAction } = require('../src');
const apiRepo =
  process.env.NULLPROTOCOL_API_REPO ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../nullprotocol-api');
const { createPool } = await import(pathToFileURL(path.join(apiRepo, 'src/db.js')).href);
const { createApp } = await import(pathToFileURL(path.join(apiRepo, 'src/app.js')).href);
assert.ok(process.env.TEST_DATABASE_URL);
assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
const pool = createPool(process.env.TEST_DATABASE_URL);
const tag = randomBytes(5).toString('hex');
const admin = randomBytes(32).toString('hex');
const server = createApp({
  pool,
  adminToken: admin,
  sessionSecret: randomBytes(32).toString('hex'),
  sessionVerifier: null,
  logger: { error() {} }
});
let teamId, userId, spaceId;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token, method = 'GET', body) => {
    const response = await fetch(endpoint + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    const result = text ? JSON.parse(text) : null;
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${result?.error}`);
    return result;
  };
  const team = `sdkc-team-${tag}`;
  const slug = `sdkc-space-${tag}`;
  teamId = (await call('/v1/admin/teams', admin, 'POST', { slug: team, name: 'SDK C' })).team.id;
  userId = (await call('/v1/admin/users', admin, 'POST', { email: `${tag}@example.test` })).user.id;
  await call(`/v1/admin/teams/${team}/members`, admin, 'POST', { userId, role: 'owner' });
  const owner = (await call(`/v1/admin/users/${userId}/tokens`, admin, 'POST', { label: 'SDK C' }))
    .token.token;
  spaceId = (await call(`/v1/teams/${team}/spaces`, owner, 'POST', { slug, name: 'SDK C' })).space
    .id;
  const base = `/v1/spaces/${slug}`;
  const key = async scopes =>
    (await call(`${base}/space-keys`, owner, 'POST', { label: 'SDK C', scopes })).key.spaceKey;
  const app = new NullProtocolClient({
    spaceKey: await key([
      'templates:write',
      'agents:write',
      'agents:read',
      'runs:create',
      'runs:read',
      'context:read',
      'context:write',
      'conversations:read',
      'conversations:delete'
    ]),
    endpoint
  });
  const manager = app;
  const caller = app;
  const content = app;
  const executorKey = await key(['runtime:connect', 'runs:execute']);
  const calls = [];
  const action = defineAction({
    name: 'getOrder',
    description: 'Read an order',
    effect: 'read',
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    handler: async args => {
      calls.push(args);
      return { status: 'shipped' };
    }
  });
  const write = defineAction({
    ...action,
    name: 'refund',
    description: 'Refund an order',
    effect: 'write',
    output: { type: 'object', properties: { receipt: { type: 'string' } }, required: ['receipt'] },
    handler: async args => {
      calls.push(args);
      return args.id === '124' ? { receipt: 'R-124' } : { unexpected: 'result' };
    }
  });
  const model = { provider: 'local', model: 'fake-model', credentialRef: 'localModel' };
  const template = await manager.templates.create({
    name: 'Support',
    config: {
      instructions: 'Answer the user.',
      model,
      actions: [action, write],
      memory: { mode: 'conversation' }
    }
  });
  const agent = (await manager.agents.create({ templateId: template.template.id })).agent;
  const modelRequests = [];
  const executor = new ManagedExecutor({
    executorKey,
    endpoint,
    agentIds: [agent.id],
    credentials: { localModel: { provider: 'local', baseURL: 'http://127.0.0.1:11434/v1' } },
    actions: [action, write],
    modelFetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      modelRequests.push(request);
      if (request.messages[0].content.startsWith('Compact the supplied')) {
        const sources = JSON.parse(request.messages[1].content).sources;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    facts: [{ value: { orderId: '123' }, sourceSeqs: [sources[0].seq] }],
                    summary: 'The customer discussed order 123.'
                  })
                }
              }
            ]
          })
        );
      }
      const current = request.messages.at(-1).content;
      const wantsRefund = current.includes('Refund order');
      const refundAvailable = request.tools?.some(tool => tool.function.name === 'refund');
      if (
        request.messages.some(message => message.role === 'tool') &&
        JSON.stringify(request.messages).includes('then fail')
      ) {
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      }
      const response = request.messages.some(message => message.role === 'tool')
        ? { choices: [{ message: { content: 'It shipped.' } }] }
        : wantsRefund && !refundAvailable
          ? { choices: [{ message: { content: 'I cannot verify the full history yet.' } }] }
        : {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: wantsRefund ? 'refund' : 'getOrder',
                        arguments:
                          wantsRefund && current.includes('124') ? '{"id":"124"}' : '{"id":"123"}'
                      }
                    }
                  ]
                }
              }
            ]
          };
      return new Response(JSON.stringify(response));
    }
  });
  await executor.register();
  const run = await caller
    .agent(agent.id)
    .startRun('Where is order 123?', { conversation: 'ticket-123' });
  const committed = await executor.pollOnce();
  assert.equal(committed.run.status, 'succeeded');
  const final = await caller.agent(agent.id).getRun(run.id);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.output.text, 'It shipped.');
  assert.deepEqual(calls, [{ id: '123' }]);
  const trace = await caller.agent(agent.id).listSteps(run.id);
  assert.deepEqual(
    trace.steps.map(s => `${s.kind}:${s.status}`),
    ['model:succeeded', 'action:succeeded', 'model:succeeded']
  );
  const second = await caller
    .agent(agent.id)
    .startRun('Refund order 123', { conversation: 'ticket-123' });
  const uncertain = await executor.pollOnce();
  assert.equal(uncertain.run.status, 'failed');
  assert.equal(uncertain.run.errorCode, 'action_outcome_unknown');
  const secondTrace = await caller.agent(agent.id).listSteps(second.id);
  assert.ok(secondTrace.steps.some(step => step.kind === 'action' && step.status === 'unknown'));
  assert.equal((await caller.agent(agent.id).getRun(second.id)).unreconciledOutcomes, 1);
  const third = await caller
    .agent(agent.id)
    .startRun('Refund order 124', { conversation: 'ticket-124' });
  assert.equal((await executor.pollOnce()).run.status, 'succeeded');
  const stored = await pool.query(
    'SELECT content FROM conversation_messages WHERE run_id=$1 AND role=$2',
    [third.id, 'assistant']
  );
  assert.equal(stored.rows[0].content.actionOutcomes[0].name, 'refund');
  assert.equal(stored.rows[0].content.actionOutcomes[0].status, 'succeeded');
  const fourth = await caller
    .agent(agent.id)
    .startRun('Refund order 124 then fail', { conversation: 'ticket-125' });
  assert.equal((await executor.pollOnce()).run.status, 'failed');
  const failedHistory = await pool.query(
    'SELECT content FROM conversation_messages WHERE run_id=$1 AND role=$2',
    [fourth.id, 'assistant']
  );
  assert.equal(failedHistory.rows[0].content.actionOutcomes[0].status, 'succeeded');
  assert.equal(failedHistory.rows[0].content.errorCode, 'model_error');
  await content.agent(agent.id).context.put('region', { value: 'EU', ifVersion: null });
  await content.agent(agent.id).memory.add({ text: 'Prefers brief replies.' });
  const conversation = await content.agent(agent.id).conversations.get('ticket-124');
  for (let seq = 3; seq <= 34; seq++) {
    await pool.query(
      'INSERT INTO conversation_messages(conversation_id,seq,run_id,role,content) VALUES ($1,$2,$3,$4,$5)',
      [
        conversation.conversation.id,
        seq,
        third.id,
        seq % 2 ? 'user' : 'assistant',
        JSON.stringify(
          seq === 4
            ? {
                text: 'Refund complete',
                actionOutcomes: [
                  { name: 'refund', runId: third.id, callId: 'historical', status: 'succeeded' }
                ]
              }
            : `history ${seq}`
        )
      ]
    );
  }
  await pool.query('UPDATE managed_conversations SET version=17 WHERE id=$1', [
    conversation.conversation.id
  ]);
  const fifth = await caller
    .agent(agent.id)
    .startRun('Where is order 123?', { conversation: 'ticket-124' });
  const compacted = await executor.pollOnce();
  assert.equal(compacted.run.status, 'succeeded');
  const compactedConversation = await content.agent(agent.id).conversations.get('ticket-124');
  assert.ok(compactedConversation.summary.coversToSeq >= 22);
  assert.ok(compactedConversation.facts.every(fact => !fact.value.actionOutcome));
  assert.ok(
    modelRequests.some(request =>
      request.messages.some(
        message =>
          typeof message.content === 'string' &&
          message.content.includes('recentActionOutcomes') &&
          message.content.includes(third.id)
      )
    )
  );
  assert.equal((await caller.agent(agent.id).getRun(fifth.id)).status, 'succeeded');
  for (let seq = 37; seq <= 130; seq++) {
    await pool.query(
      'INSERT INTO conversation_messages(conversation_id,seq,run_id,role,content) VALUES ($1,$2,$3,$4,$5)',
      [
        conversation.conversation.id,
        seq,
        fifth.id,
        seq % 2 ? 'user' : 'assistant',
        JSON.stringify(`later history ${seq}`)
      ]
    );
  }
  const writesBeforeGap = calls.length;
  const sixth = await caller
    .agent(agent.id)
    .startRun('Refund order 124', { conversation: 'ticket-124' });
  const incomplete = await executor.pollOnce();
  assert.equal(incomplete.run.status, 'succeeded');
  assert.equal(incomplete.run.output.text, 'I cannot verify the full history yet.');
  assert.equal(calls.length, writesBeforeGap);
  const incompleteTrace = await caller.agent(agent.id).listSteps(sixth.id);
  assert.ok(
    incompleteTrace.steps.some(
      step =>
        step.kind === 'compaction' &&
        step.status === 'failed' &&
        step.payload.errorCode === 'compaction_backlog'
    )
  );
  assert.ok(
    modelRequests.some(request =>
      request.messages.some(
        message =>
          typeof message.content === 'string' && message.content.includes('memoryIncomplete')
      )
    )
  );
  assert.ok(
    modelRequests.some(
      request =>
        request.messages.at(-1)?.content?.includes('Refund order 124') &&
        !request.tools?.some(tool => tool.function.name === 'refund')
    )
  );
  const memoryState = (await content.agent(agent.id).conversations.get('ticket-124'))
    .conversation.memoryState;
  assert.equal(memoryState.backlog, true);
  assert.equal(memoryState.capacityExceeded, false);
  assert.ok(memoryState.uncompactedMessages > 50);
  console.log('Managed SDK/API integration passed');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (spaceId) {
    await pool.query('DELETE FROM spaces WHERE id=$1', [spaceId]);
  }
  if (teamId) await pool.query('DELETE FROM team_members WHERE team_id=$1', [teamId]);
  if (userId) {
    await pool.query('DELETE FROM user_tokens WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  }
  if (teamId) await pool.query('DELETE FROM teams WHERE id=$1', [teamId]);
  await pool.end();
}
