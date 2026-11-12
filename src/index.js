/**
 * NullProtocol: an Agent with a model, instructions, context and memory, and
 * four operations whose replies are checked in code. Without a key the Agent
 * lives in the process. With a key the same object reads and writes the saved
 * Agent in its Space, and every operation is recorded there.
 */

const { randomUUID } = require('crypto');
const { createRuntime } = require('./runtime');
const { validateModel } = require('./model');
const { AgentError, MESSAGES, savedStore } = require('./platform');
const { knowledgeLibrary, agentKnowledge } = require('./knowledge');

const missing = (code, found) => {
  if (!found) throw new AgentError(code, MESSAGES[code]);
};

// One scope of context entries kept in the process.
function localContext(entries = new Map()) {
  return {
    entries,
    list: async () => [...entries.values()],
    get: async name => {
      missing('context_key_not_found', entries.has(name));
      return entries.get(name);
    },
    set: async (name, value, { inclusion } = {}) => {
      const entry = {
        key: name,
        value,
        inclusion: inclusion ?? entries.get(name)?.inclusion ?? 'always',
        version: randomUUID()
      };
      entries.set(name, entry);
      return entry;
    },
    delete: async name => missing('context_key_not_found', entries.delete(name))
  };
}

// The saved tasks of an Agent that lives in the process.
function localTasks(tasks = new Map()) {
  return {
    list: async () => [...tasks.values()],
    get: async name => {
      missing('task_not_found', tasks.has(name));
      return tasks.get(name);
    },
    set: async (name, { ifRevision, ...settings }) => {
      const revision = tasks.get(name)?.revision ?? null;
      if (ifRevision !== undefined && ifRevision !== revision) {
        throw new AgentError('task_revision_conflict', MESSAGES.task_revision_conflict);
      }
      const task = { name, ...settings, revision: (revision ?? 0) + 1 };
      tasks.set(name, task);
      return task;
    },
    delete: async name => missing('task_not_found', tasks.delete(name))
  };
}

// Settings, context and memory of an Agent that lives in the process.
function localStore(settings) {
  const unavailable = async () => {
    throw new AgentError(
      'knowledge_unavailable',
      'Knowledge requires a saved Agent and its Space SDK key.'
    );
  };
  const space = { ...localContext(), knowledge: knowledgeLibrary(unavailable, AgentError) };
  const context = localContext();
  let notes = [];
  return {
    space,
    context,
    knowledge: agentKnowledge(unavailable, '', AgentError),
    tasks: localTasks(),
    settings: async () => ({ ...settings }),
    update: async changes => Object.assign(settings, changes),
    turn: async contextKeys => {
      // The Agent's entry replaces the Space's under the same key.
      const all = new Map([...space.entries, ...context.entries]);
      return {
        settings: { ...settings },
        entries: [...all.values()].filter(
          entry => entry.inclusion === 'always' || contextKeys.includes(entry.key)
        ),
        notes,
        missing: contextKeys.filter(name => !all.has(name))
      };
    },
    record: async () => {},
    recordAction: async () => {},
    memory: {
      list: async () => notes,
      add: async text => {
        const note = { id: randomUUID(), text };
        notes.push(note);
        return note;
      },
      delete: async id => {
        missing(
          'note_not_found',
          notes.some(note => note.id === id)
        );
        notes = notes.filter(note => note.id !== id);
      }
    }
  };
}

// Check setup mistakes before creating records or making network requests.
function optionsObject(options, method) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AgentError('invalid_options', `NullProtocol.${method} needs an options object.`);
  }
  return options;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError('invalid_options', `${name} must be a nonempty string.`);
  }
}

// The same Space key authorizes storage and NullProtocol-hosted models.
function hostedCredentials(key, endpoint) {
  return key
    ? {
        nullprotocol: {
          apiKey: key,
          baseURL: `${(endpoint || process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai').replace(/\/+$/, '')}/v1`
        }
      }
    : {};
}

const NullProtocol = {
  /**
   * Creates an Agent and returns it with its agentId. With `key` the Agent is
   * saved in the Space of that key; without it the Agent lives in this process.
   */
  async create(options) {
    const {
      key,
      endpoint,
      agentId,
      name,
      provider,
      model,
      instructions = '',
      apiKey,
      baseURL,
      credentials,
      ...rest
    } = optionsObject(options, 'create');
    try {
      validateModel({ provider, model });
    } catch (error) {
      throw new AgentError('invalid_options', error.message);
    }
    if (typeof instructions !== 'string') {
      throw new AgentError('invalid_options', 'instructions must be a string.');
    }
    if (agentId !== undefined) nonempty(agentId, 'agentId');
    if (key !== undefined) nonempty(key, 'key');
    if (endpoint !== undefined) nonempty(endpoint, 'endpoint');
    const settings = { provider, model, instructions };
    if (provider === 'nullprotocol' && !key) {
      throw new AgentError(
        'key_required',
        'A NullProtocol-hosted model needs the SDK key of a Space.'
      );
    }
    const own = {
      ...credentials,
      ...hostedCredentials(key, endpoint),
      ...(provider !== 'nullprotocol'
        ? { [provider]: { apiKey, baseURL, ...credentials?.[provider] } }
        : {})
    };
    if (!key) {
      return createRuntime({
        ...rest,
        agentId: agentId ?? `agent-${randomUUID().slice(0, 8)}`,
        store: localStore(settings),
        credentials: own
      });
    }
    const store = savedStore({ key, endpoint, conversation: rest.conversation });
    const { agent } = await store.request('POST', '/agents', { agentId, name, ...settings });
    return createRuntime({
      ...rest,
      agentId: agent.agentId,
      store: savedStore({ key, endpoint, agentId: agent.agentId, conversation: rest.conversation }),
      credentials: own
    });
  },

  /** Loads a saved Agent by its agentId. Its model and instructions come from the Space. */
  async load(options) {
    const { key, endpoint, agentId, credentials = {}, ...rest } = optionsObject(options, 'load');
    if (!key) {
      throw new AgentError(
        'key_required',
        'NullProtocol.load reads a saved Agent and needs key, the SDK key of its Space. Without a key, create the Agent in code with NullProtocol.create.'
      );
    }
    nonempty(key, 'key');
    nonempty(agentId, 'agentId');
    if (endpoint !== undefined) nonempty(endpoint, 'endpoint');
    const store = savedStore({ key, endpoint, agentId, conversation: rest.conversation });
    await store.settings();
    return createRuntime({
      ...rest,
      agentId,
      store,
      credentials: {
        ...credentials,
        ...hostedCredentials(key, endpoint)
      }
    });
  }
};

module.exports = { NullProtocol, AgentError };
