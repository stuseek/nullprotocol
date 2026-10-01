// Control from a NullProtocol Space. A process keeps one connection per runtime
// key and endpoint; serveAgents and clients register their agents on it, so one
// manifest reports them all and one poller serves them.

const crypto = require('crypto');

const links = new Map();

class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

function cancelled(code) {
  return Object.assign(new Error('Run cancelled'), { name: 'AbortError', code });
}

function syncUrl(runtimeKey, runtimeEndpoint) {
  if (!/^np_runtime_[A-Za-z0-9_-]{43}$/.test(runtimeKey)) {
    throw new Error('Invalid runtime control key');
  }
  const endpoint = new URL(runtimeEndpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Runtime control endpoint must be an origin URL');
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    )
  ) {
    throw new Error('Runtime control endpoint must use HTTPS');
  }
  return new URL('/v1/runtime/sync', endpoint).toString();
}

function controlLink(runtimeKey, runtimeEndpoint) {
  const url = syncUrl(runtimeKey, runtimeEndpoint);
  const id = `${url} ${runtimeKey}`;
  let link = links.get(id);
  if (!link) {
    link = new ControlLink(url, runtimeKey, () => links.delete(id));
    links.set(id, link);
  }
  return link;
}

// A member is { pollMs, agents(), applied(id, state, stopped), afterSync() }.
// agents() lists its manifest entries; applied() receives each agent's desired
// state after a sync; afterSync() runs after every attempt.
class ControlLink {
  constructor(url, key, release) {
    this.url = url;
    this.key = key;
    this.release = release;
    this.instanceId = crypto.randomUUID();
    this.members = new Set();
    // Agent ID to its last confirmed { paused, blocked, revision, stopEpoch }.
    this.states = new Map();
    this.lastSuccessfulSync = 0;
    // The API refused the key (401 or 403); cleared by the next successful sync.
    this.rejected = false;
    this.waiters = new Set();
    this.syncing = null;
    this.again = false;
    this.request = null;
    this.pollMs = null;
    this.timer = null;
    this.retryTimer = null;
    this.retryFailures = 0;
    this.retryNotBefore = 0;
  }

  join(member) {
    this.members.add(member);
    this.schedule();
    if (this.syncing) this.again = true;
    else void this.sync();
    return () => this.leave(member);
  }

  leave(member) {
    if (!this.members.delete(member)) return;
    if (this.members.size) {
      this.schedule();
      return;
    }
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    this.request?.abort();
    this.timer = null;
    this.retryTimer = null;
    this.release();
  }

  schedule() {
    const pollMs = Math.min(...[...this.members].map(member => member.pollMs));
    if (pollMs === this.pollMs) return;
    clearInterval(this.timer);
    this.pollMs = pollMs;
    this.timer = setInterval(() => void this.sync(), pollMs);
    this.timer.unref();
  }

  // Resolves once a sync has reported this agent, the key was refused, one of
  // the signals is aborted, or the time is up.
  waitFor(id, ms, signals) {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', done);
        this.waiters.delete(waiter);
        resolve();
      };
      const waiter = () => {
        if (this.states.has(id) || this.rejected) done();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      for (const signal of signals) signal.addEventListener('abort', done, { once: true });
      this.waiters.add(waiter);
    });
  }

  manifest() {
    const agents = new Map();
    for (const member of this.members) {
      for (const agent of member.agents()) {
        const known = agents.get(agent.id);
        if (known) {
          known.activeRuns += agent.activeRuns;
          continue;
        }
        const state = this.states.get(agent.id);
        agents.set(agent.id, {
          id: agent.id,
          mode: agent.mode,
          model:
            typeof agent.model === 'string' &&
            agent.model.length <= 120 &&
            !/[\u0000-\u001f\u007f-\u009f]/.test(agent.model)
              ? agent.model
              : null,
          operations: agent.operations,
          observedRevision: state?.revision ?? 0,
          observedStopEpoch: state?.stopEpoch ?? 0,
          activeRuns: agent.activeRuns
        });
      }
    }
    return agents;
  }

  async sync() {
    if (!this.members.size) return false;
    if (this.syncing) return this.syncing;
    if (Date.now() < this.retryNotBefore) {
      for (const member of this.members) member.afterSync?.();
      return false;
    }
    this.retryNotBefore = 0;
    let changed = false;
    let retryable = true;
    let retryAfterMs = 0;
    this.syncing = (async () => {
      const controller = new AbortController();
      this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const manifest = this.manifest();
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId: this.instanceId,
            sdkVersion: require('../package.json').version,
            agents: [...manifest.values()]
          }),
          redirect: 'error',
          signal: controller.signal
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) this.rejected = true;
          retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
          if (response.status === 429) {
            const retrySeconds = Number(response.headers.get('retry-after'));
            if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
              retryAfterMs = Math.min(retrySeconds * 1000, 60000);
            }
          }
          return false;
        }
        const result = await response.json();
        if (!Array.isArray(result.agents) || result.agents.length !== manifest.size) return false;
        const desired = new Map(result.agents.map(item => [item.agent_id, item]));
        if (desired.size !== manifest.size) return false;
        for (const id of manifest.keys()) {
          const state = desired.get(id);
          const known = this.states.get(id);
          if (
            !state ||
            !Number.isInteger(state.revision) ||
            state.revision < (known?.revision ?? 0) ||
            !Number.isInteger(state.stop_epoch) ||
            state.stop_epoch < (known?.stopEpoch ?? 0) ||
            typeof state.paused !== 'boolean' ||
            (state.blocked !== undefined && typeof state.blocked !== 'boolean')
          ) {
            return false;
          }
        }
        for (const id of manifest.keys()) {
          const state = desired.get(id);
          const known = this.states.get(id);
          const next = {
            paused: state.paused,
            blocked: !!state.blocked,
            revision: state.revision,
            stopEpoch: state.stop_epoch
          };
          if (
            !known ||
            next.revision !== known.revision ||
            next.stopEpoch !== known.stopEpoch ||
            next.paused !== known.paused ||
            next.blocked !== known.blocked
          ) {
            changed = true;
          }
          const stopped =
            next.stopEpoch > (known?.stopEpoch ?? 0) || (next.blocked && !known?.blocked);
          this.states.set(id, next);
          for (const member of this.members) member.applied(id, next, stopped);
        }
        this.lastSuccessfulSync = Date.now();
        this.rejected = false;
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
        this.request = null;
        for (const member of this.members) member.afterSync?.();
        for (const waiter of this.waiters) waiter();
      }
    })();
    try {
      const succeeded = await this.syncing;
      if (succeeded) {
        retryable = false;
        this.retryFailures = 0;
      }
      return succeeded;
    } finally {
      this.syncing = null;
      if (!retryable) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryNotBefore = 0;
      }
      if (retryable && this.members.size && !this.retryTimer) {
        this.retryFailures++;
        const delay = Math.max(
          retryAfterMs,
          Math.min(1000 * 2 ** Math.min(this.retryFailures - 1, 3), 8000) +
            Math.floor(Math.random() * 1000)
        );
        this.retryNotBefore = Date.now() + delay;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.retryNotBefore = 0;
          void this.sync();
        }, delay);
        this.retryTimer.unref();
      }
      if ((changed || this.again) && this.members.size) {
        this.again = false;
        const ack = setTimeout(() => void this.sync(), 0);
        ack.unref();
      }
    }
  }
}

// Control for one client and its copies. It reports one agent ID, refuses that
// agent's new operations while it is paused, and cancels its running ones on stop.
// A new connection needs one confirmed state first, so a restart cannot skip a
// pause; after that the last confirmed state holds through a network outage.
class ClientControl {
  constructor(runtimeKey, runtimeEndpoint, agent) {
    syncUrl(runtimeKey, runtimeEndpoint);
    this.runtimeKey = runtimeKey;
    this.runtimeEndpoint = runtimeEndpoint;
    // The connection is taken on the first operation, so a client that never
    // runs one holds nothing.
    this.link = null;
    this.agent = agent;
    this.runs = new Set();
    this.leave = null;
    this.closed = false;
    this.lifetime = new AbortController();
    this.member = {
      pollMs: 15000,
      agents: () => [{ ...agent, activeRuns: this.runs.size }],
      applied: (id, _state, stopped) => {
        if (id !== agent.id || !stopped) return;
        for (const run of this.runs) run.abort(cancelled('run_cancelled'));
      }
    };
  }

  // `signal` is the caller's: aborting it ends the wait for a first state, and
  // begin then throws its reason without registering a run.
  async begin(signal) {
    if (this.closed) throw new ControlError('control_closed', 'This client was closed');
    signal?.throwIfAborted();
    if (!this.leave) {
      this.link = controlLink(this.runtimeKey, this.runtimeEndpoint);
      this.leave = this.link.join(this.member);
    }
    const { id } = this.agent;
    if (!this.link.states.has(id) && !this.link.rejected) {
      await this.link.waitFor(
        id,
        10000,
        signal ? [this.lifetime.signal, signal] : [this.lifetime.signal]
      );
      if (this.closed) throw new ControlError('control_closed', 'This client was closed');
      signal?.throwIfAborted();
    }
    if (this.link.rejected) {
      throw new ControlError('control_rejected', 'The runtime key was refused by the control API');
    }
    const state = this.link.states.get(id);
    if (!state) {
      throw new ControlError(
        'control_unavailable',
        `Control state for agent ${id} is not available`
      );
    }
    if (state.paused || state.blocked) {
      throw new ControlError('agent_paused', `Agent ${id} is paused`);
    }
    const run = new AbortController();
    this.runs.add(run);
    return run;
  }

  end(run) {
    this.runs.delete(run);
  }

  close() {
    this.closed = true;
    this.lifetime.abort();
    for (const run of this.runs) run.abort(cancelled('client_closed'));
    this.leave?.();
  }
}

module.exports = { syncUrl, controlLink, ClientControl, ControlError };
