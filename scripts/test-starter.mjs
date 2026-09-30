// Runs examples/managed/starter as a new user would, as separate processes
// with a local OpenAI-compatible model: setup, executor, ask, executor restart
// with memory, Agent Context, pause and delete.
//
// By default the API runs in process on TEST_DATABASE_URL with a disposable
// team. `--production KEYFILE` uses api.nullprotocol.ai with the app and
// executor keys from a mode-0600 JSON file
// {"NULLPROTOCOL_APP_KEY": "...", "NULLPROTOCOL_EXECUTOR_KEY": "..."}; it creates a
// uniquely named Template and Agent and deletes only those.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localSpace } from './local-space.mjs';

const require = createRequire(import.meta.url);
const { NullProtocolClient } = require('../src');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --packed runs the starter from the npm tarball, with production dependencies
// only, so it cannot reach files outside the package.
let starter = path.join(root, 'examples/managed/starter');
let packDir;
if (process.argv.includes('--packed')) {
  const run = promisify(execFile);
  packDir = await mkdtemp(path.join(tmpdir(), 'nullprotocol-pack-'));
  const { stdout } = await run('npm', ['pack', '--pack-destination', packDir], { cwd: root });
  await run('tar', ['-xzf', path.join(packDir, stdout.trim().split('\n').at(-1))], {
    cwd: packDir
  });
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: path.join(packDir, 'package')
  });
  starter = path.join(packDir, 'package/examples/managed/starter');
}
const tag = randomBytes(5).toString('hex');
const production = process.argv.indexOf('--production');

async function productionSpace(file) {
  assert.equal((await stat(file)).mode & 0o077, 0, `${file} must be readable by its owner only`);
  const values = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(values.NULLPROTOCOL_APP_KEY && values.NULLPROTOCOL_EXECUTOR_KEY, 'keys file');
  return {
    endpoint: 'https://api.nullprotocol.ai',
    appKey: values.NULLPROTOCOL_APP_KEY,
    executorKey: values.NULLPROTOCOL_EXECUTOR_KEY,
    cleanup: async () => {}
  };
}

const space =
  production === -1
    ? await localSpace([
        'templates:write',
        'agents:write',
        'agents:read',
        'runs:create',
        'runs:read',
        'context:write'
      ])
    : await productionSpace(process.argv[production + 1]);
const { endpoint } = space;
const app = new NullProtocolClient({ spaceKey: space.appKey, endpoint });
const executors = new Set();
let agentId, templateId;
try {
  const env = {
    ...process.env,
    NULLPROTOCOL_API_URL: endpoint,
    NULLPROTOCOL_APP_KEY: space.appKey,
    NULLPROTOCOL_EXECUTOR_KEY: space.executorKey,
    NULLPROTOCOL_AGENT_NAME: `Starter check ${tag}`,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL || 'http://127.0.0.1:11434/v1',
    MODEL_NAME: process.env.MODEL_NAME || 'qwen2.5:7b-instruct'
  };
  const node = (script, args = []) =>
    promisify(execFile)(process.execPath, [path.join(starter, script), ...args], { env }).then(
      ({ stdout }) => stdout.trim(),
      error => ({ code: error.code, stdout: error.stdout.trim(), stderr: error.stderr.trim() })
    );

  const setup = await node('setup.js');
  assert.match(setup, /^NULLPROTOCOL_AGENT_ID=[0-9a-f-]{36}$/);
  assert.equal(await node('setup.js'), setup, 'rerunning setup returns the same Agent');
  env.NULLPROTOCOL_AGENT_ID = agentId = setup.split('=')[1];
  templateId = (await app.agents.get(agentId)).agent.templateId;

  const startExecutor = async () => {
    const child = spawn(process.execPath, [path.join(starter, 'executor.js')], { env });
    executors.add(child);
    child.once('exit', () => executors.delete(child));
    let output = '';
    child.stderr.on('data', chunk => (output += chunk));
    const [line] = await once(child.stdout, 'data');
    assert.match(String(line), /registered/, output);
    child.lines = () => output;
    return child;
  };
  const stopExecutor = async (child, signal = 'SIGTERM') => {
    const exited = once(child, 'exit');
    if (signal) child.kill(signal);
    return (await exited)[0];
  };

  const runtime = async () => (await app.agent(agentId).runtime()).runtime;
  assert.equal((await runtime()).online, false);
  const offline = await node('ask.js', ['Hello', 'customer-0']);
  assert.match(offline.stderr, /runtime_offline\nNo executor is connected/);
  // SIGTERM exits 0 even when deregistration fails.
  const stub = createServer((request, response) => {
    if (request.url === '/v1/space') return response.end('{"space":{"slug":"stub"}}');
    if (request.url.endsWith('/claim')) return; // wait until the executor aborts
    response.statusCode = request.method === 'DELETE' ? 500 : 200;
    response.end(request.method === 'DELETE' ? '{"error":"internal_error"}' : '{"executor":{}}');
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const real = env.NULLPROTOCOL_API_URL;
  env.NULLPROTOCOL_API_URL = `http://127.0.0.1:${stub.address().port}`;
  const failing = await startExecutor();
  assert.equal(await stopExecutor(failing), 0);
  assert.match(failing.lines(), /executor: internal_error/);
  env.NULLPROTOCOL_API_URL = real;
  stub.closeAllConnections();
  stub.close();

  let executor = await startExecutor();
  assert.deepEqual(
    { ...(await runtime()), lastSeenAt: null },
    { online: true, lastSeenAt: null, missingActions: [], modelCompatible: true }
  );
  const first = await node('ask.js', ['My name is Stan. Where is order 42?', 'customer-1']);
  assert.match(first, /^action getOrder \(read\): succeeded$/m, JSON.stringify(first));
  assert.match(first, /shipped/i);

  assert.equal(await stopExecutor(executor), 0, 'SIGTERM exits cleanly');
  executor = await startExecutor();
  const remembered = await node('ask.js', ['What is my name?', 'customer-1']);
  assert.match(remembered, /Stan/, 'conversation memory survives an executor restart');

  await app.agent(agentId).context.put('signature', {
    value: 'Always end every reply with the exact signature "-- Nora, Support".',
    ifVersion: null
  });
  const signed = await node('ask.js', ['Is order 42 on its way?', 'customer-2']);
  assert.match(signed, /Nora/, 'Agent Context reaches the next run');

  const { agent } = await app.agents.get(agentId);
  await app.agents.update(agentId, { state: 'paused', ifRevision: agent.revision });
  const paused = await node('ask.js', ['Hello', 'customer-3']);
  assert.equal(paused.code, 1);
  assert.match(paused.stderr, /agent_paused\nThe Agent is paused/);

  await app.agents.delete(agentId);
  agentId = null;
  const code = await stopExecutor(executor, null);
  assert.equal(code, 1, 'the executor exits once its only Agent is deleted');
  assert.match(executor.lines(), /agent_removed/);
  console.log('Starter path passed');
} finally {
  for (const child of executors) child.kill('SIGKILL');
  // Only what this run created; keys stay for their owner to revoke.
  if (agentId) await app.agents.delete(agentId).catch(error => console.error(error.code));
  if (templateId) await app.templates.delete(templateId).catch(error => console.error(error.code));
  await space.cleanup();
  if (packDir) await rm(packDir, { recursive: true, force: true });
}
