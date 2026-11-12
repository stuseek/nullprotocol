// A saved Agent over HTTP: the same store an Agent in the process has, kept in its Space.

const { URLSearchParams } = require('url');
const { setTimeout: pause } = require('timers/promises');
const { knowledgeLibrary, agentKnowledge } = require('./knowledge');

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
  version_conflict: 'The saved data changed since it was read. Read the latest version and retry.',
  revision_conflict: 'The Agent settings changed since they were read. Read them again and retry.',
  context_entry_too_large:
    'The context entry is too large. An entry sent with every operation holds 8 KiB; one with inclusion "selected" holds 64 KiB.',
  context_limit_reached: 'The Agent has the maximum number of context entries.',
  memory_limit_reached: 'The Agent has the maximum number of memory notes.',
  context_key_not_found: 'No context entry with this key.',
  invalid_context_key:
    'A saved Context key must start with a lowercase letter and contain 1–64 lowercase letters, digits, dots, underscores or hyphens; for example order_id.',
  invalid_context_value:
    'Context value must be JSON-serializable. JSON null is allowed; use delete to remove an entry.',
  note_not_found: 'No memory note with this ID.',
  knowledge_not_found: 'No Knowledge document with this ID in the requested scope.',
  knowledge_document_too_large: 'A Knowledge document holds up to 1 MiB of UTF-8 text.',
  task_not_found: 'This Agent has no saved task with this name.',
  invalid_task_name:
    'A task name must start with a lowercase letter and contain 1–64 lowercase letters, digits, dots, underscores or hyphens; for example read-request.',
  task_revision_conflict: 'The task changed since it was read. Read it again and retry.',
  task_limit_reached: 'The Agent has the maximum number of saved tasks.'
};

function savedStore({ key, endpoint, agentId, conversation }) {
  const base = `${(endpoint || process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai').replace(/\/+$/, '')}/v1`;
  const scope = extra => {
    const query = new URLSearchParams({ ...(conversation ? { conversation } : {}), ...extra });
    return query.size ? `?${query}` : '';
  };

  // `busy` is the Space's own answer before it took the request up, so nothing
  // was done and the request is sent again. No other failure is retried.
  async function request(method, path, body, options = {}, attempt = 1) {
    options.signal?.throwIfAborted();
    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: options.signal ?? AbortSignal.timeout(15000)
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new AgentError(
        'platform_unavailable',
        `NullProtocol could not be reached: ${error.message}`
      );
    }
    const result = await response.json().catch(() => {
      if (options.signal?.aborted) throw options.signal.reason;
      return {};
    });
    if (response.status === 503 && result.error === 'busy' && attempt < 4) {
      await pause(250 * attempt, undefined, { signal: options.signal });
      return request(method, path, body, options, attempt + 1);
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
  const contextKey = name => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(name)) {
      throw new AgentError('invalid_context_key', MESSAGES.invalid_context_key, { field: 'key' });
    }
    return name;
  };
  const contextValue = value => {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return JSON.parse(json);
    } catch {
      // A serialization mistake belongs to the value, not the network.
    }
    throw new AgentError('invalid_context_value', MESSAGES.invalid_context_value, {
      field: 'value'
    });
  };
  const task = name => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(name)) {
      throw new AgentError('invalid_task_name', MESSAGES.invalid_task_name, { field: 'name' });
    }
    return `${agent}/tasks/${name}`;
  };
  // One scope of context entries: the Agent's (or its conversation's), or the Space's.
  const contextAt = (path, query) => ({
    list: async () => (await request('GET', path + query)).entries,
    get: async name => (await request('GET', `${path}/${contextKey(name)}${query}`)).entry,
    set: async (name, value, options = {}) =>
      (
        await request('PUT', `${path}/${contextKey(name)}${query}`, {
          value: contextValue(value),
          ...options
        })
      ).entry,
    delete: async name => request('DELETE', `${path}/${contextKey(name)}${query}`)
  });
  return {
    request,
    settings: async () => (await request('GET', `${agent}/settings`)).agent,
    update: async changes => (await request('PATCH', `${agent}/settings`, changes)).agent,
    // Settings, the context an operation is sent, its documents and the notes, in one read.
    // `budget` is how many characters of documents the operation can take.
    turn: async (contextKeys, budget, knowledgeQuery) => {
      const { agent: settings, ...rest } = await request('POST', `${agent}/turn`, {
        keys: contextKeys,
        conversation: conversation || undefined,
        budget,
        ...(knowledgeQuery !== undefined && { knowledgeQuery })
      });
      return { settings, ...rest };
    },
    record: operation => request('POST', `${agent}/operations`, operation),
    recordAction: (operationId, action) =>
      request('POST', `${agent}/operations/${operationId}/actions`, action),
    context: contextAt(`${agent}/context`, scope()),
    space: { ...contextAt('/context', ''), knowledge: knowledgeLibrary(request, AgentError) },
    knowledge: agentKnowledge(request, agentId, AgentError),
    tasks: {
      list: async () => (await request('GET', `${agent}/tasks`)).tasks,
      get: async name => (await request('GET', task(name))).task,
      set: async (name, settings) => (await request('PUT', task(name), settings)).task,
      delete: name => request('DELETE', task(name))
    },
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
