/**
 * Configuration Management for AI Toolkit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigLoader {
  load(options = {}) {
    // Start with defaults
    let config = this.getDefaults();

    // Load from config file
    const fileConfig = this.loadFromFile(options.configFile);
    if (fileConfig) {
      config = { ...config, ...fileConfig };
    }

    // Load from environment variables
    const envConfig = this.loadFromEnv();
    config = { ...config, ...envConfig };

    // Apply runtime options (highest priority)
    config = { ...config, ...options };

    // Handle special cases
    this.processConfig(config);

    return config;
  }

  getDefaults() {
    return {
      defaultEngine: 'openai',
      engines: {},
      models: {
        openai: 'gpt-4',
        anthropic: 'claude-sonnet-4-5-20250929'
      },
      temperature: 0.3,
      maxTokens: 1000,
      telemetry: false,
      validateOutputs: false,
      withExecutor: false,
      logging: false,
      audit: false,
      debug: false
    };
  }

  loadFromFile(configFile) {
    const searchPaths = configFile
      ? [configFile]
      : [
          './nullprotocol.config.js',
          './nullprotocol.config.json',
          './.nullprotocolrc',
          './ai-toolkit.config.js',
          './ai-toolkit.config.json',
          './.ai-toolkit.rc',
          path.join(process.cwd(), 'ai-toolkit.config.js'),
          path.join(os.homedir(), '.ai-toolkit', 'config.json')
        ];

    for (const configPath of searchPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const ext = path.extname(configPath);

          if (ext === '.js') {
            return require(path.resolve(configPath));
          } else {
            const content = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(content);
          }
        }
      } catch (error) {
        console.warn(`Failed to load config from ${configPath}:`, error.message);
      }
    }

    return null;
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

module.exports = { ConfigLoader };
