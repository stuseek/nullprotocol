#!/usr/bin/env node

/**
 * CLI: nullprotocol-serve
 *
 * Start the NullProtocol HTTP server.
 *
 * Usage:
 *   npx nullprotocol-serve
 *   npx nullprotocol-serve --port 8080
 *   npx nullprotocol-serve --config ./agents.js
 *
 * Environment:
 *   OPENAI_API_KEY       - OpenAI API key
 *   ANTHROPIC_API_KEY    - Anthropic API key
 *   NULLPROTOCOL_PORT      - Server port (default: 3000)
 *   NULLPROTOCOL_HOST      - Bind address (default: 127.0.0.1)
 *   NULLPROTOCOL_API_KEY   - Required Bearer token auth
 *   NULLPROTOCOL_CORS      - Optional CORS origin
 *   AI_DEFAULT_ENGINE    - Default engine (openai or anthropic)
 */

const { serve } = require('../src/server');
const { resolve } = require('path');

// Parse simple CLI args
const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
  else if (arg === '--config' && args[i + 1]) opts.config = args[++i];
  else if (arg === '--host' && args[i + 1]) opts.host = args[++i];
  else if (arg === '--engine' && args[i + 1]) opts.defaultEngine = args[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log(`nullprotocol-serve — run model operations as HTTP endpoints

Usage:
  npx nullprotocol-serve [options]

Install this source release from GitHub before running the command.
The package is not published to npm yet.

Options:
  --port <n>       Port to listen on (default: 3000)
  --host <addr>    Bind address (default: 127.0.0.1 locally)
  --engine <name>  Default AI engine: openai or anthropic
  --config <file>  JavaScript module exporting server options, including agents

Environment variables:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, NULLPROTOCOL_PORT,
  NULLPROTOCOL_HOST, NULLPROTOCOL_API_KEY, NULLPROTOCOL_CORS,
  NP_AGENTS (comma-separated agent IDs when --config defines agents)

Named agents use PORT, then NULLPROTOCOL_PORT, then 3000. The host is
NULLPROTOCOL_HOST, or 0.0.0.0 when PORT is set, or 127.0.0.1 otherwise.
Explicit port and host options take precedence.

Legacy single-agent endpoints:
  POST /extract    { data, schema, ...opts }
  POST /validate   { criteria, subject, reference?, ...opts }
  POST /summarize  { content, ...opts }
  POST /decide     { context, actions, ...opts }
  POST /chat       { prompt, ...opts }
  GET  /health     Server status + circuit breaker stats

Named agents: POST /v1/agents/:id/invoke (see README for session routes)
`);
    process.exit(0);
  }
}

const { config, ...overrides } = opts;
serve(config ? { ...require(resolve(config)), ...overrides } : overrides);
