// A disposable team, Space and keys on an in-process API backed by
// TEST_DATABASE_URL. cleanup() stops the server and deletes what was created.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function localSpace(appScopes) {
  const apiRepo = process.env.NULLPROTOCOL_API_REPO || path.resolve(root, '../nullprotocol-api');
  const { createPool } = await import(pathToFileURL(path.join(apiRepo, 'src/db.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(apiRepo, 'src/app.js')).href);
  assert.ok(process.env.TEST_DATABASE_URL);
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = createPool(process.env.TEST_DATABASE_URL);
  const admin = randomBytes(32).toString('hex');
  const server = createApp({
    pool,
    adminToken: admin,
    sessionSecret: randomBytes(32).toString('hex'),
    sessionVerifier: null,
    managedAgentsEnabled: true,
    logger: { error() {} }
  });
  let teamId, userId, spaceId;
  const cleanup = async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (spaceId) await pool.query('DELETE FROM spaces WHERE id=$1', [spaceId]);
    if (teamId) await pool.query('DELETE FROM team_members WHERE team_id=$1', [teamId]);
    if (userId) {
      await pool.query('DELETE FROM user_tokens WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    }
    if (teamId) await pool.query('DELETE FROM teams WHERE id=$1', [teamId]);
    await pool.end();
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, token, method = 'GET', body) => {
      const response = await fetch(endpoint + route, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const result = await response.json();
      assert.ok(response.ok, `${method} ${route}: ${response.status} ${result?.error}`);
      return result;
    };
    const tag = randomBytes(5).toString('hex');
    const team = `starter-team-${tag}`;
    const slug = `starter-space-${tag}`;
    teamId = (await call('/v1/admin/teams', admin, 'POST', { slug: team, name: 'Starter' })).team
      .id;
    userId = (await call('/v1/admin/users', admin, 'POST', { email: `${tag}@example.test` })).user
      .id;
    await call(`/v1/admin/teams/${team}/members`, admin, 'POST', { userId, role: 'owner' });
    const owner = (await call(`/v1/admin/users/${userId}/tokens`, admin, 'POST', { label: 'S' }))
      .token.token;
    spaceId = (await call(`/v1/teams/${team}/spaces`, owner, 'POST', { slug, name: 'Starter' }))
      .space.id;
    const key = async scopes =>
      (await call(`/v1/spaces/${slug}/space-keys`, owner, 'POST', { label: 'Starter', scopes })).key
        .spaceKey;
    return {
      endpoint,
      appKey: await key(appScopes),
      executorKey: await key(['runtime:connect', 'runs:execute']),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
