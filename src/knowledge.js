// Knowledge source management. Preparation and retrieval stay on the server.
const { setTimeout: pause } = require('timers/promises');

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
  const all = async options =>
    (await (options ? request('GET', path, undefined, options) : request('GET', path))).sources;
  const waitUntilReady = async (source, options = {}) => {
    object(options, ['timeout', 'signal']);
    if (
      !source ||
      typeof source !== 'object' ||
      !Number.isInteger(source.revision) ||
      source.revision < 1
    ) {
      invalid('Pass the Knowledge revision returned by add, update or get.');
    }
    const id = uuid(source.id),
      version = uuid(source.version),
      revision = source.revision;
    const { timeout = 120000, signal } = options;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
      invalid('Knowledge timeout must be a positive number of milliseconds, at most 2147483647.');
    }
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) {
      invalid('Use an AbortSignal to cancel Knowledge preparation waiting.');
    }
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new AgentError(
            'knowledge_wait_timeout',
            'Knowledge preparation did not finish within the timeout.',
            { documentId: id, version, timeout }
          )
        ),
      timeout
    );
    try {
      for (;;) {
        const current = (await all({ signal: controller.signal })).find(item => item.id === id);
        controller.signal.throwIfAborted();
        if (!current) {
          throw new AgentError(
            'knowledge_not_found',
            'This Knowledge document was deleted or is not accessible.',
            { documentId: id }
          );
        }
        if (current.version !== version) {
          throw new AgentError(
            'version_conflict',
            'The Knowledge document changed while waiting. Read its current revision before continuing.',
            { documentId: id, version: current.version }
          );
        }
        if (current.state === 'ready' && current.activeRevision === revision) return current;
        if (current.state === 'failed' && !current.retryScheduled) {
          throw new AgentError(
            'knowledge_prepare_failed',
            'Knowledge preparation failed. Inspect the document and explicitly retry it.',
            { documentId: id, reason: current.error }
          );
        }
        await pause(500, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
  return {
    all,
    api: {
      list: async () => (await all()).filter(source => source.scope === scope),
      get: async id => (await request('GET', `${path}/${uuid(id)}`)).source,
      waitUntilReady,
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
