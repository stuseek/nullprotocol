// A saved Agent over HTTP: the same store an Agent in the process has, kept in its Space.

const { URLSearchParams } = require('url');

class AgentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    Object.assign(this, details);
  }
}

const MESSAGES = {
  agent_not_found:
    'No saved Agent with this agentId in the Space. Create it with NullProtocol.create or in the cabinet.',
  agent_exists: 'An Agent with this agentId already exists. Use NullProtocol.load to work with it.',
  agent_id_deleted: 'An Agent with this agentId was deleted. Choose another agentId.',
  agent_limit_reached: 'The Space has reached its Agent limit.',
  version_conflict: 'The context entry changed since it was read. Read it again and retry.',
  revision_conflict: 'The Agent settings changed since they were read. Read them again and retry.',
  context_entry_too_large:
    'The context entry is too large. An entry sent with every operation holds 8 KiB; one with inclusion "selected" holds 64 KiB.',
  context_limit_reached: 'The Agent has the maximum number of context entries.',
  memory_limit_reached: 'The Agent has the maximum number of memory notes.',
  context_key_not_found: 'No context entry with this key.',
  note_not_found: 'No memory note with this ID.'
};

function savedStore({ key, endpoint, agentId, conversation }) {
  const base = `${(endpoint || process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai').replace(/\/+$/, '')}/v1`;
  const scope = extra => {
    const query = new URLSearchParams({ ...(conversation ? { conversation } : {}), ...extra });
    return query.size ? `?${query}` : '';
  };

  // `busy` is the Space's own answer before it took the request up, so nothing
  // was done and the request is sent again. No other failure is retried.
  async function request(method, path, body, attempt = 1) {
    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new AgentError(
        'platform_unavailable',
        `NullProtocol could not be reached: ${error.message}`
      );
    }
    const result = await response.json().catch(() => ({}));
    if (response.status === 503 && result.error === 'busy' && attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      return request(method, path, body, attempt + 1);
    }
    if (response.ok) return result;
    if (response.status === 401 || response.status === 403) {
      throw new AgentError(
        'key_refused',
        'NullProtocol refused the key: it is invalid, revoked or not an SDK key. Create an SDK key in the Space.'
      );
    }
    const { error: code = 'platform_error', ...details } = result;
    throw new AgentError(
      code,
      MESSAGES[code] || `NullProtocol answered ${response.status}`,
      details
    );
  }

  const agent = `/agents/${agentId}`;
  // One scope of context entries: the Agent's (or its conversation's), or the Space's.
  const contextAt = (path, query) => ({
    list: async () => (await request('GET', path + query)).entries,
    get: async name => (await request('GET', `${path}/${name}${query}`)).entry,
    set: async (name, value, options = {}) =>
      (await request('PUT', `${path}/${name}${query}`, { value, ...options })).entry,
    delete: name => request('DELETE', `${path}/${name}${query}`)
  });
  return {
    request,
    settings: async () => (await request('GET', `${agent}/settings`)).agent,
    update: async changes => (await request('PATCH', `${agent}/settings`, changes)).agent,
    // Settings, the context an operation is sent and the notes, in one read.
    turn: async contextKeys => {
      const { agent: settings, ...rest } = await request(
        'GET',
        `${agent}/turn${scope(contextKeys.length ? { keys: contextKeys.join(',') } : {})}`
      );
      return { settings, ...rest };
    },
    record: operation => request('POST', `${agent}/operations`, operation),
    recordAction: (operationId, action) =>
      request('POST', `${agent}/operations/${operationId}/actions`, action),
    context: contextAt(`${agent}/context`, scope()),
    space: contextAt('/context', ''),
    memory: {
      list: async () => (await request('GET', `${agent}/memory${scope()}`)).notes,
      add: async text =>
        (
          await request('POST', `${agent}/memory`, {
            text,
            ...(conversation ? { conversation } : {})
          })
        ).note,
      delete: id => request('DELETE', `${agent}/memory/${id}`)
    }
  };
}

module.exports = { AgentError, MESSAGES, savedStore };
