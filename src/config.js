// Configuration defaults, config files and environment variables.

const fs = require('fs');
const path = require('path');

// The model settings a constructor takes: `provider` picks the protocol, `model`
// is the name sent to it. They map onto the engine settings the client already
// uses, so the rest of the library does not need to know which form was used.
// Cloud providers name their endpoint so the SDKs cannot take another one from
// OPENAI_BASE_URL or ANTHROPIC_BASE_URL.
const PROVIDERS = {
  openai: { engine: 'openai', keyEnv: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1' },
  anthropic: {
    engine: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com'
  },
  'openai-compatible': { engine: 'openai' }
};
const MODEL_FIELDS = ['provider', 'model', 'apiKey', 'baseURL'];
const ENGINE_FIELDS = ['engines', 'models', 'defaultEngine', 'openaiBaseURL'];

function modelSettings({ provider, model, apiKey, baseURL }) {
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(
      `Unknown provider ${JSON.stringify(provider)}. Use openai, anthropic or openai-compatible.`
    );
  }
  const spec = PROVIDERS[provider];
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`provider ${provider} needs model, the name of the model to call`);
  }
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) {
    throw new Error('apiKey must be a nonempty string');
  }
  if (spec.keyEnv) {
    if (baseURL !== undefined) {
      throw new Error(
        provider === 'openai'
          ? 'baseURL is not used with provider openai. For another server that speaks the OpenAI API, use provider openai-compatible.'
          : 'baseURL is not used with provider anthropic, which always calls the Anthropic API.'
      );
    }
    // A cloud key is read from its own variable only for its own provider.
    const key = apiKey ?? process.env[spec.keyEnv];
    if (!key) throw new Error(`provider ${provider} needs apiKey or ${spec.keyEnv}`);
    return { engine: spec.engine, model, apiKey: key, baseURL: spec.endpoint };
  }
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      'provider openai-compatible needs baseURL, the http(s) address of your server, such as http://localhost:11434/v1 for Ollama'
    );
  }
  return { engine: spec.engine, model, apiKey, baseURL };
}

class ConfigLoader {
  // Precedence, lowest first: defaults, config file, environment, options.
  // With `provider` (in the file or options) the model settings come only from
  // provider, model, apiKey and baseURL, plus the provider's own key variable;
  // the engine settings and their environment variables are not used.
  load(options = {}) {
    const fileConfig = this.loadFromFile(options.configFile) || {};
    const envConfig = this.loadFromEnv();
    const given = { ...fileConfig, ...options };

    if (given.provider === undefined) {
      const stray = MODEL_FIELDS.filter(field => given[field] !== undefined);
      if (stray.length) {
        throw new Error(
          `${stray.join(', ')} need provider (openai, anthropic or openai-compatible)`
        );
      }
      const config = { ...this.getDefaults(), ...fileConfig, ...envConfig, ...options };
      this.processConfig(config);
      return config;
    }

    const mixed = ENGINE_FIELDS.filter(field => given[field] !== undefined);
    if (mixed.length) {
      throw new Error(
        `provider cannot be combined with ${mixed.join(', ')}; use provider, model, apiKey and baseURL`
      );
    }
    // The engine settings below replace any that the environment set.
    const settings = modelSettings(given);
    return {
      ...this.getDefaults(),
      ...fileConfig,
      ...envConfig,
      ...options,
      model: settings.model,
      apiKey: settings.apiKey,
      defaultEngine: settings.engine,
      engines: { [settings.engine]: settings.apiKey },
      models: { [settings.engine]: settings.model },
      openaiBaseURL: settings.engine === 'openai' ? settings.baseURL : undefined
    };
  }

  getDefaults() {
    return {
      defaultEngine: 'openai',
      engines: {},
      models: {
        openai: 'gpt-4',
        anthropic: 'claude-sonnet-5'
      },
      temperature: 0.3,
      maxTokens: 1000,
      telemetry: false,
      telemetryTimeline: false,
      validateOutputs: false,
      withExecutor: false,
      debug: false
    };
  }

  // An explicit file must load; `false` skips files. Otherwise the first default
  // file found is used, and one that exists but cannot be read is an error too.
  loadFromFile(configFile) {
    if (configFile === false) return null;
    const configPath =
      configFile ||
      ['./nullprotocol.config.js', './nullprotocol.config.json', './.nullprotocolrc'].find(file =>
        fs.existsSync(file)
      );
    if (!configPath) return null;
    try {
      if (path.extname(configPath) === '.js') return require(path.resolve(configPath));
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot load config file ${configPath}: ${error.message}`);
    }
  }

  loadFromEnv() {
    const config = {};

    // API Keys
    if (process.env.OPENAI_API_KEY) {
      config.engines = config.engines || {};
      config.engines.openai = process.env.OPENAI_API_KEY;
    }

    if (process.env.ANTHROPIC_API_KEY) {
      config.engines = config.engines || {};
      config.engines.anthropic = process.env.ANTHROPIC_API_KEY;
    }

    // Legacy cloud token is recognized only to report a clear error.
    if (process.env.AI_TOOLKIT_TOKEN) {
      config.token = process.env.AI_TOOLKIT_TOKEN;
    }

    if (process.env.NULLPROTOCOL_TELEMETRY_KEY || process.env.AI_TOOLKIT_KEY) {
      config.telemetryKey = process.env.NULLPROTOCOL_TELEMETRY_KEY || process.env.AI_TOOLKIT_KEY;
    }

    if (process.env.NULLPROTOCOL_TELEMETRY_ENDPOINT) {
      config.telemetryEndpoint = process.env.NULLPROTOCOL_TELEMETRY_ENDPOINT;
    }

    if (process.env.NULLPROTOCOL_SPACE_CONTEXT_KEY) {
      config.spaceContextKey = process.env.NULLPROTOCOL_SPACE_CONTEXT_KEY;
    }

    if (process.env.NULLPROTOCOL_SPACE_CONTEXT_ENDPOINT) {
      config.spaceContextEndpoint = process.env.NULLPROTOCOL_SPACE_CONTEXT_ENDPOINT;
    }

    // Settings
    if (process.env.AI_DEFAULT_ENGINE) {
      config.defaultEngine = process.env.AI_DEFAULT_ENGINE;
    }

    if (process.env.NULLPROTOCOL_OPENAI_BASE_URL || process.env.AI_TOOLKIT_OPENAI_BASE_URL) {
      config.openaiBaseURL =
        process.env.NULLPROTOCOL_OPENAI_BASE_URL || process.env.AI_TOOLKIT_OPENAI_BASE_URL;
    }

    if (process.env.AI_MODEL_OPENAI) {
      config.models = config.models || {};
      config.models.openai = process.env.AI_MODEL_OPENAI;
    }

    if (process.env.AI_MODEL_ANTHROPIC) {
      config.models = config.models || {};
      config.models.anthropic = process.env.AI_MODEL_ANTHROPIC;
    }

    if (process.env.NULLPROTOCOL_TELEMETRY === 'true') {
      config.telemetry = true;
    } else if (
      process.env.NULLPROTOCOL_TELEMETRY === 'false' ||
      process.env.AI_TELEMETRY === 'false'
    ) {
      config.telemetry = false;
    }
    if (process.env.NULLPROTOCOL_TELEMETRY_TIMELINE === 'true') {
      config.telemetryTimeline = true;
    }

    if (process.env.AI_VALIDATE_OUTPUTS === 'true') {
      config.validateOutputs = true;
    }

    if (process.env.AI_DEBUG === 'true') {
      config.debug = true;
    }

    return config;
  }

  processConfig(config) {
    if (config.token && !config.engines.openai && !config.engines.anthropic) {
      throw new Error(
        'AI_TOOLKIT_TOKEN cloud mode is unavailable. Configure an OpenAI or Anthropic API key.'
      );
    }

    // Check if at least one engine is configured
    if (!config.engines.openai && !config.engines.anthropic) {
      console.warn(
        'No AI engine configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or pass engines to AIToolkit.'
      );
    }

    return config;
  }
}

// The effective configuration as options for another client, without reading
// the config file again. With provider, the engine settings derived from it are
// left out so they are derived again.
function configCopy(config) {
  const copy = { ...config, configFile: false };
  if (copy.provider) for (const field of ENGINE_FIELDS) delete copy[field];
  return copy;
}

module.exports = { ConfigLoader, configCopy, PROVIDERS };
