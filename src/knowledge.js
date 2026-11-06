// Knowledge source management. Preparation and retrieval stay on the server.
function documents(request, path, scope, AgentError) {
  const invalid = message => {
    throw new AgentError('invalid_options', message);
  };
  const object = (value, fields) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalid('Use an options object for this Knowledge operation.');
    }
    const extra = Object.keys(value).filter(key => !fields.includes(key));
    if (extra.length) invalid(`Unknown Knowledge options: ${extra.join(', ')}.`);
    return value;
  };
  const uuid = value => {
    if (
      typeof value !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ) {
      invalid('Use the document ID and version returned by Knowledge.');
    }
    return value;
  };
  const body = (input, update = false) => {
    object(input, update ? ['name', 'text', 'ifVersion'] : ['name', 'text']);
    const result = {};
    if (!update || Object.hasOwn(input, 'name')) {
      const name = input.name;
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.trim().length > 120 ||
        /\p{Cc}/u.test(name.trim())
      ) {
        invalid('A Knowledge name must have 1–120 characters without control characters.');
      }
      result.name = name.trim();
    }
    if (!update || Object.hasOwn(input, 'text')) {
      const text = input.text;
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.includes('\0') ||
        Buffer.from(text, 'utf8').toString('utf8') !== text
      ) {
        invalid('Knowledge text must be nonempty UTF-8 text without NUL characters.');
      }
      if (Buffer.byteLength(text, 'utf8') > 1048576) {
        throw new AgentError(
          'knowledge_document_too_large',
          'A Knowledge document holds up to 1 MiB of UTF-8 text.'
        );
      }
      result.text = text;
    }
    if (update) {
      result.ifVersion = uuid(input.ifVersion);
      if (!Object.hasOwn(result, 'name') && !Object.hasOwn(result, 'text')) {
        invalid('Supply a new name or text to update a Knowledge document.');
      }
    }
    return result;
  };
  const all = async () => (await request('GET', path)).sources;
  return {
    all,
    api: {
      list: async () => (await all()).filter(source => source.scope === scope),
      get: async id => (await request('GET', `${path}/${uuid(id)}`)).source,
      add: async input => request('POST', path, body(input)),
      update: async (id, input) => request('PUT', `${path}/${uuid(id)}`, body(input, true)),
      delete: async (id, options) => {
        object(options, ['ifVersion']);
        return request('DELETE', `${path}/${uuid(id)}`, { ifVersion: uuid(options.ifVersion) });
      },
      retry: async id => request('POST', `${path}/${uuid(id)}/retry`, {})
    },
    uuid
  };
}

function knowledgeLibrary(request, AgentError) {
  const { api } = documents(request, '/knowledge', 'space', AgentError);
  return { ...api, usage: async () => (await request('GET', '/knowledge')).usage };
}

function agentKnowledge(request, agentId, AgentError) {
  const path = `/agents/${agentId}`;
  const { api, all, uuid } = documents(request, `${path}/knowledge`, 'agent', AgentError);
  return {
    ...api,
    connections: async () =>
      (await all()).filter(source => source.scope === 'space' && source.attached),
    connect: async id => request('PUT', `${path}/knowledge-links/${uuid(id)}`, {}),
    disconnect: async id => request('DELETE', `${path}/knowledge-links/${uuid(id)}`, {})
  };
}

module.exports = { knowledgeLibrary, agentKnowledge };
