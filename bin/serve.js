#!/usr/bin/env node

/**
 * CLI: nullprotocol-serve
 *
 * Start the NullProtocol HTTP server.
 *
 * Usage:
 *   npx --package nullprotocol nullprotocol-serve
 *   npx --package nullprotocol nullprotocol-serve --port 8080
 *   NULLPROTOCOL_PORT=8080 NULLPROTOCOL_API_KEY=secret npx --package nullprotocol nullprotocol-serve
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

// Parse simple CLI args
const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
  else if (arg === '--host' && args[i + 1]) opts.host = args[++i];
  else if (arg === '--engine' && args[i + 1]) opts.defaultEngine = args[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log(`nullprotocol serve — run model operations as HTTP endpoints

Usage:
  npx --package nullprotocol nullprotocol-serve [options]

Options:
  --port <n>       Port to listen on (default: 3000)
  --host <addr>    Bind address (default: 127.0.0.1)
  --engine <name>  Default AI engine: openai or anthropic

Environment variables:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, NULLPROTOCOL_PORT,
  NULLPROTOCOL_HOST, NULLPROTOCOL_API_KEY, NULLPROTOCOL_CORS

Endpoints:
  POST /extract    { data, schema, ...opts }
  POST /validate   { criteria, subject, reference?, ...opts }
  POST /summarize  { content, ...opts }
  POST /decide     { context, actions, ...opts }
  POST /chat       { prompt, ...opts }
  GET  /health     Server status + circuit breaker stats
`);
    process.exit(0);
  }
}

serve(opts);
