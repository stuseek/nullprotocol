const { randomUUID } = require('crypto');

function clone(value) {
  return structuredClone(value);
}

class MemorySessionStore {
  constructor({ maxSessions = 10000, maxSessionsPerPrincipal = 1000 } = {}) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('maxSessions must be positive');
    if (!Number.isInteger(maxSessionsPerPrincipal) || maxSessionsPerPrincipal < 1)
      throw new Error('maxSessionsPerPrincipal must be positive');
    this.maxSessions = maxSessions;
    this.maxSessionsPerPrincipal = maxSessionsPerPrincipal;
    this.sessions = new Map();
  }

  async create(ref, state = { messages: [], context: {} }, ttlMs = 86400000) {
    for (const [key, item] of this.sessions) {
      if (item.expiresAt <= Date.now()) this.sessions.delete(key);
    }
    const owned = [...this.sessions.values()].filter(
      item => item.principal === ref.principal
    ).length;
    if (owned >= this.maxSessionsPerPrincipal)
      throw Object.assign(new Error('Session limit reached'), {
        status: 429,
        code: 'session_limit_reached'
      });
    if (this.sessions.size >= this.maxSessions)
      throw Object.assign(new Error('Session store capacity reached'), {
        status: 503,
        code: 'session_store_full'
      });
    const id = randomUUID();
    this.sessions.set(id, {
      ...ref,
      state: clone(state),
      expiresAt: Date.now() + ttlMs,
      lease: null,
      leaseUntil: 0
    });
    return id;
  }

  _find(ref) {
    const item = this.sessions.get(ref.id);
    if (
      !item ||
      item.agent !== ref.agent ||
      item.principal !== ref.principal ||
      item.expiresAt <= Date.now()
    )
      return null;
    return item;
  }

  async acquire(ref, leaseMs = 30000) {
    const item = this._find(ref);
    if (!item) return { status: 'not_found' };
    if (item.lease && item.leaseUntil > Date.now()) return { status: 'busy' };
    item.lease = randomUUID();
    item.leaseUntil = Date.now() + leaseMs;
    return { status: 'acquired', lease: item.lease, state: clone(item.state) };
  }

  async commit(ref, lease, state, ttlMs = 86400000) {
    const item = this._find(ref);
    if (!item || item.lease !== lease || item.leaseUntil <= Date.now()) return false;
    item.state = clone(state);
    item.lease = null;
    item.leaseUntil = 0;
    item.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(ref, lease) {
    const item = this._find(ref);
    if (item?.lease === lease) {
      item.lease = null;
      item.leaseUntil = 0;
    }
  }

  async renew(ref, lease, leaseMs = 30000) {
    const item = this._find(ref);
    if (!item || item.lease !== lease || item.leaseUntil <= Date.now()) return false;
    item.leaseUntil = Date.now() + leaseMs;
    return true;
  }

  async clear(ref, part = 'all') {
    const item = this._find(ref);
    if (!item) return 'not_found';
    if (item.lease && item.leaseUntil > Date.now()) return 'busy';
    if (part === 'all' || part === 'history') item.state.messages = [];
    if (part === 'all' || part === 'context') item.state.context = {};
    return 'cleared';
  }

  async delete(ref) {
    const item = this._find(ref);
    if (!item) return 'not_found';
    if (item.lease && item.leaseUntil > Date.now()) return 'busy';
    this.sessions.delete(ref.id);
    return 'deleted';
  }
}

class PostgresSessionStore {
  constructor(pool, { maxSessionsPerPrincipal = 1000 } = {}) {
    if (!pool?.query || !pool?.connect)
      throw new Error('PostgresSessionStore requires a pg-compatible pool');
    if (!Number.isInteger(maxSessionsPerPrincipal) || maxSessionsPerPrincipal < 1)
      throw new Error('maxSessionsPerPrincipal must be positive');
    this.pool = pool;
    this.maxSessionsPerPrincipal = maxSessionsPerPrincipal;
  }

  async create(ref, state = { messages: [], context: {} }, ttlMs = 86400000) {
    const id = randomUUID();
    const client = await this.pool.connect();
    let discard;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('nullprotocol.sessions'),hashtext($1))",
        [ref.principal]
      );
      const count = await client.query(
        'SELECT count(*)::int AS count FROM np_sessions WHERE principal=$1 AND expires_at>now()',
        [ref.principal]
      );
      if (count.rows[0].count >= this.maxSessionsPerPrincipal)
        throw Object.assign(new Error('Session limit reached'), {
          status: 429,
          code: 'session_limit_reached'
        });
      await client.query(
        `INSERT INTO np_sessions(id,agent,principal,state,expires_at)
         VALUES ($1,$2,$3,$4,now()+($5::bigint * interval '1 millisecond'))`,
        [id, ref.agent, ref.principal, JSON.stringify(state), ttlMs]
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discard = rollbackError;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async acquire(ref, leaseMs = 30000) {
    const lease = randomUUID();
    const result = await this.pool.query(
      `UPDATE np_sessions SET lease_token=$4, lease_until=now()+($5::bigint * interval '1 millisecond')
       WHERE id=$1 AND agent=$2 AND principal=$3 AND expires_at>now()
         AND (lease_token IS NULL OR lease_until<now()) RETURNING state`,
      [ref.id, ref.agent, ref.principal, lease, leaseMs]
    );
    if (result.rowCount) return { status: 'acquired', lease, state: result.rows[0].state };
    const found = await this.pool.query(
      'SELECT 1 FROM np_sessions WHERE id=$1 AND agent=$2 AND principal=$3 AND expires_at>now()',
      [ref.id, ref.agent, ref.principal]
    );
    return { status: found.rowCount ? 'busy' : 'not_found' };
  }

  async commit(ref, lease, state, ttlMs = 86400000) {
    const result = await this.pool.query(
      `UPDATE np_sessions SET state=$5,lease_token=NULL,lease_until=NULL,
       expires_at=now()+($6::bigint * interval '1 millisecond'),updated_at=now()
       WHERE id=$1 AND agent=$2 AND principal=$3 AND lease_token=$4 AND lease_until>now() RETURNING id`,
      [ref.id, ref.agent, ref.principal, lease, JSON.stringify(state), ttlMs]
    );
    return result.rowCount === 1;
  }

  async release(ref, lease) {
    await this.pool.query(
      'UPDATE np_sessions SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND agent=$2 AND principal=$3 AND lease_token=$4',
      [ref.id, ref.agent, ref.principal, lease]
    );
  }

  async renew(ref, lease, leaseMs = 30000) {
    const result = await this.pool.query(
      `UPDATE np_sessions SET lease_until=now()+($5::bigint * interval '1 millisecond')
       WHERE id=$1 AND agent=$2 AND principal=$3 AND lease_token=$4 AND lease_until>now() AND expires_at>now() RETURNING id`,
      [ref.id, ref.agent, ref.principal, lease, leaseMs]
    );
    return result.rowCount === 1;
  }

  async purgeExpired() {
    const result = await this.pool.query('DELETE FROM np_sessions WHERE expires_at<=now()');
    return result.rowCount;
  }

  async clear(ref, part = 'all') {
    const stateSql = {
      all: `'{"messages":[],"context":{}}'::jsonb`,
      history: `jsonb_set(state,'{messages}','[]'::jsonb)`,
      context: `jsonb_set(state,'{context}','{}'::jsonb)`
    }[part];
    if (!stateSql) throw new Error('Invalid context part');
    const result = await this.pool.query(
      `UPDATE np_sessions SET state=${stateSql},updated_at=now()
       WHERE id=$1 AND agent=$2 AND principal=$3 AND expires_at>now()
         AND (lease_token IS NULL OR lease_until<now()) RETURNING id`,
      [ref.id, ref.agent, ref.principal]
    );
    if (result.rowCount) return 'cleared';
    return this._status(ref);
  }

  async delete(ref) {
    const result = await this.pool.query(
      `DELETE FROM np_sessions WHERE id=$1 AND agent=$2 AND principal=$3 AND expires_at>now()
       AND (lease_token IS NULL OR lease_until<now()) RETURNING id`,
      [ref.id, ref.agent, ref.principal]
    );
    if (result.rowCount) return 'deleted';
    return this._status(ref);
  }

  async _status(ref) {
    const r = await this.pool.query(
      'SELECT 1 FROM np_sessions WHERE id=$1 AND agent=$2 AND principal=$3 AND expires_at>now()',
      [ref.id, ref.agent, ref.principal]
    );
    return r.rowCount ? 'busy' : 'not_found';
  }
}

module.exports = { MemorySessionStore, PostgresSessionStore };
