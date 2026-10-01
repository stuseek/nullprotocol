const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const NullProtocol = require('../index');
const { serve } = require('../server');
const { serveAgents } = require('../agent-server');

const ENV = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AI_DEFAULT_ENGINE',
  'AI_MODEL_OPENAI',
  'NULLPROTOCOL_OPENAI_BASE_URL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL'
];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
});
afterEach(() => {
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

// A local OpenAI-compatible server that records what reaches it.
async function recorder() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      requests.push({
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body)
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function writeConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-model-config-'));
  const file = path.join(dir, 'nullprotocol.config.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('provider openai-compatible', () => {
  test('a local server gets the named model and no key, even with cloud keys set', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-secret';
    const server = await recorder();
    try {
      const ai = new NullProtocol({
        provider: 'openai-compatible',
        baseURL: server.baseURL,
        model: 'qwen2.5:3b-instruct'
      });
      expect((await ai.chat('hi')).success).toBe(true);
      // A per-call model is a model name, even one the engines form would read as an alias.
      await ai.chat('hi', { model: 'openai' });
      expect(server.requests.map(request => [request.path, request.body.model])).toEqual([
        ['/v1/chat/completions', 'qwen2.5:3b-instruct'],
        ['/v1/chat/completions', 'openai']
      ]);
      expect(server.requests.every(request => request.authorization === undefined)).toBe(true);
      expect(ai.telemetry).toBeNull();
      expect(ai.spaceContext).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('an explicit key is sent as the bearer token', async () => {
    const server = await recorder();
    try {
      const ai = new NullProtocol({
        provider: 'openai-compatible',
        baseURL: server.baseURL,
        model: 'local-model',
        apiKey: 'local-secret'
      });
      await ai.chat('hi');
      expect(server.requests[0].authorization).toBe('Bearer local-secret');
    } finally {
      await server.close();
    }
  });

  test('legacy engine variables in the environment do not apply', async () => {
    process.env.AI_DEFAULT_ENGINE = 'anthropic';
    process.env.AI_MODEL_OPENAI = 'gpt-4o';
    process.env.NULLPROTOCOL_OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    const server = await recorder();
    try {
      const ai = new NullProtocol({
        provider: 'openai-compatible',
        baseURL: server.baseURL,
        model: 'local-model'
      });
      await ai.chat('hi');
      expect(server.requests.map(request => request.body.model)).toEqual(['local-model']);
    } finally {
      await server.close();
    }
  });
});

describe('cloud providers', () => {
  test('openai takes an explicit key over OPENAI_API_KEY and uses the OpenAI endpoint', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const fromEnv = new NullProtocol({ provider: 'openai', model: 'gpt-5-mini' });
    expect(fromEnv.clients.openai.apiKey).toBe('sk-from-env');
    expect(fromEnv.clients.openai.baseURL).toBe('https://api.openai.com/v1');
    const explicit = new NullProtocol({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-given'
    });
    expect(explicit.clients.openai.apiKey).toBe('sk-given');
  });

  test('cloud providers call their own endpoint whatever the SDK variables say', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    const openai = new NullProtocol({ provider: 'openai', model: 'm', apiKey: 'k' });
    expect(openai.clients.openai.baseURL).toBe('https://api.openai.com/v1');
    const anthropic = new NullProtocol({ provider: 'anthropic', model: 'm', apiKey: 'k' });
    expect(anthropic.clients.anthropic.baseURL).toBe('https://api.anthropic.com');
    const local = new NullProtocol({
      provider: 'openai-compatible',
      model: 'm',
      baseURL: 'http://localhost:11434/v1'
    });
    expect(local.clients.openai.baseURL).toBe('http://localhost:11434/v1');
  });

  test('a missing provider SDK is reported as it is, not as a later missing engine', () => {
    jest.doMock('@anthropic-ai/sdk', () => {
      throw Object.assign(new Error("Cannot find module '@anthropic-ai/sdk'"), {
        code: 'MODULE_NOT_FOUND'
      });
    });
    try {
      jest.isolateModules(() => {
        const Isolated = require('../index');
        expect(() => new Isolated({ provider: 'anthropic', model: 'm', apiKey: 'k' })).toThrow(
          "Cannot find module '@anthropic-ai/sdk'"
        );
      });
    } finally {
      jest.dontMock('@anthropic-ai/sdk');
    }
  });

  test('anthropic reads ANTHROPIC_API_KEY, not the OpenAI key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(() => new NullProtocol({ provider: 'anthropic', model: 'claude-sonnet-5' })).toThrow(
      'provider anthropic needs apiKey or ANTHROPIC_API_KEY'
    );
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    const ai = new NullProtocol({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(ai.clients.anthropic.apiKey).toBe('sk-anthropic');
    expect(ai.clients.openai).toBeUndefined();
  });
});

describe('configuration errors before any request', () => {
  test.each([
    [{ provider: 'ollama', model: 'm' }, 'Unknown provider "ollama"'],
    [
      { provider: 'constructor', model: 'm', baseURL: 'http://x/v1' },
      'Unknown provider "constructor"'
    ],
    [{ provider: 'openai-compatible', baseURL: 'http://localhost:11434/v1' }, 'needs model'],
    [{ provider: 'openai-compatible', baseURL: 'http://x/v1', model: '  ' }, 'needs model'],
    [
      { provider: 'openai-compatible', baseURL: 'http://x/v1', model: 'm', apiKey: 17 },
      'apiKey must be a nonempty string'
    ],
    [{ provider: 'openai-compatible', model: 'm' }, 'needs baseURL'],
    [{ provider: 'openai-compatible', model: 'm', baseURL: 'localhost:11434' }, 'needs baseURL'],
    [
      { provider: 'openai', model: 'm', apiKey: 'k', baseURL: 'http://x/v1' },
      'use provider openai-compatible'
    ],
    [{ provider: 'openai', model: 'm' }, 'needs apiKey or OPENAI_API_KEY'],
    [{ model: 'qwen2.5:3b-instruct' }, 'model need provider'],
    [{ apiKey: 'k', baseURL: 'http://x/v1' }, 'apiKey, baseURL need provider'],
    [
      {
        provider: 'openai-compatible',
        model: 'm',
        baseURL: 'http://x/v1',
        engines: {},
        models: {}
      },
      'provider cannot be combined with engines, models'
    ]
  ])('%j', (options, message) => {
    expect(() => new NullProtocol(options)).toThrow(message);
  });

  test('a baseURL with anthropic is refused without pointing at openai-compatible', () => {
    expect(
      () =>
        new NullProtocol({ provider: 'anthropic', model: 'm', apiKey: 'k', baseURL: 'http://x' })
    ).toThrow(
      /^baseURL is not used with provider anthropic, which always calls the Anthropic API\.$/
    );
  });

  test('provider in options cannot be combined with engines from the config file', () => {
    const config = writeConfig({ engines: { openai: 'sk-file' } });
    try {
      expect(
        () =>
          new NullProtocol({
            configFile: config.file,
            provider: 'openai-compatible',
            model: 'm',
            baseURL: 'http://x/v1'
          })
      ).toThrow('provider cannot be combined with engines');
    } finally {
      config.remove();
    }
  });
});

test('options override the config file field by field', async () => {
  const server = await recorder();
  const config = writeConfig({
    provider: 'openai-compatible',
    baseURL: server.baseURL,
    model: 'file-model'
  });
  try {
    const ai = new NullProtocol({ configFile: config.file, model: 'option-model' });
    await ai.chat('hi');
    expect(server.requests.map(request => request.body.model)).toEqual(['option-model']);
  } finally {
    config.remove();
    await server.close();
  }
});

describe('copies keep the effective configuration', () => {
  test('without reading the config file again', () => {
    const config = writeConfig({
      provider: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      model: 'file-model'
    });
    const ai = new NullProtocol({ configFile: config.file });
    config.remove();
    const copy = ai.withContext('More.');
    expect(copy.clients.openai.baseURL).toBe('http://localhost:11434/v1');
    expect(copy._resolveModel(undefined, 'openai')).toBe('file-model');
  });

  test('with provider', async () => {
    const server = await recorder();
    try {
      const ai = new NullProtocol({
        provider: 'openai-compatible',
        baseURL: server.baseURL,
        model: 'local-model',
        apiKey: 'local-secret',
        temperature: 0.1,
        basePrompt: 'You help with orders.'
      });
      await ai.withContext('Answer briefly.').chat('hi');
      await ai.forDomain('devops').chat('hi');
      const [withContext, forDomain] = server.requests;
      expect(withContext).toMatchObject({
        authorization: 'Bearer local-secret',
        body: { model: 'local-model', temperature: 0.1 }
      });
      expect(withContext.body.messages[0].content).toContain('You help with orders.');
      expect(withContext.body.messages[0].content).toContain('Answer briefly.');
      expect(forDomain).toMatchObject({
        authorization: 'Bearer local-secret',
        body: { model: 'local-model' }
      });
    } finally {
      await server.close();
    }
  });

  test('with engines, after the config file and environment change', () => {
    const config = writeConfig({ temperature: 0.2, models: { openai: 'file-model' } });
    process.env.OPENAI_API_KEY = 'sk-first';
    try {
      const ai = new NullProtocol({ configFile: config.file, basePrompt: 'Base.' });
      fs.writeFileSync(config.file, '{ "temperature": 0.9 }');
      process.env.OPENAI_API_KEY = 'sk-second';
      const copy = ai.withContext('More.');
      expect(copy.clients.openai.apiKey).toBe('sk-first');
      expect(copy.config.temperature).toBe(0.2);
      expect(copy._resolveModel(undefined, 'openai')).toBe('file-model');
      expect(copy.basePrompt).toBe('Base.\n\nMore.');
    } finally {
      config.remove();
    }
  });
});

describe('HTTP services', () => {
  test('serve keeps apiKey for HTTP access and never sends it to the model server', async () => {
    const upstream = await recorder();
    const server = serve({
      port: 0,
      apiKey: 'http-access-key',
      provider: 'openai-compatible',
      baseURL: upstream.baseURL,
      model: 'local-model'
    });
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: 'POST',
        headers: { authorization: 'Bearer http-access-key', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      });
      expect(response.status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].authorization).toBeUndefined();
    } finally {
      await new Promise(resolve => server.close(resolve));
      await upstream.close();
    }
  });

  test('serve with provider openai takes the model key from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-model';
    const server = serve({
      port: 0,
      apiKey: 'http-access-key',
      provider: 'openai',
      model: 'gpt-5-mini'
    });
    try {
      expect(server.ai.clients.openai.apiKey).toBe('sk-model');
    } finally {
      server.close();
    }
  });

  test('serveAgents uses the outer apiKey for HTTP and the definition apiKey for the model', async () => {
    const upstream = await recorder();
    const server = serveAgents({
      port: 0,
      apiKey: 'http-access-key',
      agents: [
        {
          id: 'support',
          mode: 'stateless',
          operations: ['chat'],
          provider: 'openai-compatible',
          baseURL: upstream.baseURL,
          model: 'local-model',
          apiKey: 'model-key'
        }
      ]
    });
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/v1/agents/support/invoke`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer http-access-key', 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'chat', input: { prompt: 'hi' } })
        }
      );
      expect(response.status).toBe(200);
      expect(upstream.requests.map(request => [request.authorization, request.body.model])).toEqual(
        [['Bearer model-key', 'local-model']]
      );
    } finally {
      await server.shutdown({ drainTimeoutMs: 100, cancelTimeoutMs: 100 });
      await upstream.close();
    }
  });
});
