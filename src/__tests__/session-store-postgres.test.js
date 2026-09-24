const { readFileSync } = require('fs');
const { resolve } = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { PostgresSessionStore } = require('../session-store');

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgreSQL session store', () => {
  let pool;
  let store;
  const agent = `test-${randomUUID()}`;
  const owner = { agent, principal: 'alice' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(readFileSync(resolve(__dirname, '../../sql/session-store.sql'), 'utf8'));
    store = new PostgresSessionStore(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM np_sessions WHERE agent=$1', [agent]);
      await pool.end();
    }
  });

  test('persists state and serializes concurrent turns', async () => {
    const id = await store.create(owner, { messages: [], context: { place: 'forest' } });
    const ref = { ...owner, id };
    const [a, b] = await Promise.all([store.acquire(ref), store.acquire(ref)]);
    expect([a.status, b.status].sort()).toEqual(['acquired', 'busy']);
    const lease = a.status === 'acquired' ? a.lease : b.lease;
    expect(await store.renew(ref, lease, 60000)).toBe(true);
    expect(await store.commit(ref, randomUUID(), { messages: [], context: {} })).toBe(false);
    expect(
      await store.commit(ref, lease, {
        messages: [{ role: 'user', content: 'hello' }],
        context: { place: 'forest' }
      })
    ).toBe(true);
    expect((await store.acquire({ ...ref, principal: 'bob' })).status).toBe('not_found');
    const next = await store.acquire(ref);
    expect(next.state.messages).toHaveLength(1);
    expect(next.state.context.place).toBe('forest');
    await store.release(ref, next.lease);
    expect(await store.clear(ref, 'history')).toBe('cleared');
    expect(await store.clear(ref, 'context')).toBe('cleared');
    const again = await store.acquire(ref);
    expect(again.state).toEqual({ messages: [], context: {} });
    await store.release(ref, again.lease);
    expect(await store.delete(ref)).toBe('deleted');
    expect(await store.delete(ref)).toBe('not_found');
    expect((await store.acquire(ref)).status).toBe('not_found');
  });

  test('removes expired sessions', async () => {
    const id = await store.create(owner, { messages: [], context: {} });
    await pool.query("UPDATE np_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
      id
    ]);
    expect((await store.acquire({ ...owner, id })).status).toBe('not_found');
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
  });

  test('starting a turn refreshes PostgreSQL session expiry', async () => {
    const id = await store.create(owner, { messages: [], context: {} });
    const ref = { ...owner, id };
    await pool.query("UPDATE np_sessions SET expires_at=now()+interval '1 minute' WHERE id=$1", [
      id
    ]);
    const acquired = await store.acquire(ref);
    expect(acquired.status).toBe('acquired');
    const expiry = await pool.query(
      "SELECT expires_at>now()+interval '23 hours' AS extended FROM np_sessions WHERE id=$1",
      [id]
    );
    expect(expiry.rows[0].extended).toBe(true);
    await store.release(ref, acquired.lease);
  });

  test('concurrent creates cannot exceed the principal quota', async () => {
    const limited = new PostgresSessionStore(pool, { maxSessionsPerPrincipal: 1 });
    const principal = `quota-${randomUUID()}`;
    const results = await Promise.allSettled([
      limited.create({ agent, principal }),
      limited.create({ agent, principal })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0].reason).toMatchObject({
      status: 429,
      code: 'session_limit_reached'
    });
  });
});
