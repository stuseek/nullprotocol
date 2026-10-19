/**
 * NullProtocol: an Agent with a model, instructions, context and memory, and
 * four operations whose replies are checked in code. Without a key the Agent
 * lives in the process. With a key the same object reads and writes the saved
 * Agent in its Space, and every operation is recorded there.
 */

const { randomUUID } = require('crypto');
const { createRuntime } = require('./runtime');
const { AgentError, MESSAGES, savedStore } = require('./platform');

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

// Settings, context and memory of an Agent that lives in the process.
function localStore(settings) {
  const space = localContext();
  const context = localContext();
  let notes = [];
  return {
    space,
    context,
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

const NullProtocol = {
  /**
   * Creates an Agent and returns it with its agentId. With `key` the Agent is
   * saved in the Space of that key; without it the Agent lives in this process.
   */
  async create({
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
  }) {
    const settings = { provider, model, instructions };
    if (provider === 'nullprotocol' && !key) {
      throw new AgentError(
        'key_required',
        'A NullProtocol-hosted model needs the SDK key of a Space.'
      );
    }
    const hosted = key
      ? {
          nullprotocol: {
            apiKey: key,
            baseURL: `${(endpoint || process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai').replace(/\/+$/, '')}/v1`
          }
        }
      : {};
    const own = {
      ...credentials,
      ...hosted,
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
  async load({ key, endpoint, agentId, credentials = {}, ...rest }) {
    if (!key) {
      throw new AgentError(
        'key_required',
        'NullProtocol.load reads a saved Agent and needs key, the SDK key of its Space. Without a key, create the Agent in code with NullProtocol.create.'
      );
    }
    const store = savedStore({ key, endpoint, agentId, conversation: rest.conversation });
    await store.settings();
    return createRuntime({
      ...rest,
      agentId,
      store,
      credentials: {
        ...credentials,
        nullprotocol: {
          apiKey: key,
          baseURL: `${(endpoint || process.env.NULLPROTOCOL_API_URL || 'https://api.nullprotocol.ai').replace(/\/+$/, '')}/v1`
        }
      }
    });
  }
};

module.exports = { NullProtocol, AgentError };
