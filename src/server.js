/**
 * NullProtocol HTTP Server
 *
 * Exposes the same primitives (extract, validate, summarize, decide, chat)
 * as HTTP endpoints. Zero external dependencies — uses Node's built-in http.
 *
 * Usage:
 *   const { serve } = require('nullprotocol');
 *   const server = serve({ port: 3000, engines: { anthropic: '...' } });
 *
 * Or CLI:
 *   npx nullprotocol-serve
 */

const http = require('http');

function serve(options = {}) {
  if (options.agents) return require('./agent-server').serveAgents(options);
  // Lazy-require to avoid circular — server.js only loaded when serve() called
  const AIToolkit = require('./index');

  const portValue = process.env.NULLPROTOCOL_PORT || process.env.AI_TOOLKIT_PORT;
  const port = options.port ?? (portValue ? parseInt(portValue, 10) : 3000);
  const host =
    options.host ?? process.env.NULLPROTOCOL_HOST ?? process.env.AI_TOOLKIT_HOST ?? '127.0.0.1';
  const apiKey =
    options.apiKey || process.env.NULLPROTOCOL_API_KEY || process.env.AI_TOOLKIT_API_KEY || null;
  if (!apiKey) throw new Error('NULLPROTOCOL_API_KEY is required to start the HTTP server');
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('maxBodyBytes must be a positive integer');
  }

  // Strip server-only options, pass the rest to AIToolkit
  const { port: _p, host: _h, apiKey: _k, cors, maxBodyBytes: _m, ...toolkitOpts } = options;
  const ai = new AIToolkit(toolkitOpts);

  const corsOrigin = cors || process.env.NULLPROTOCOL_CORS || process.env.AI_TOOLKIT_CORS || null;

  // Route table — maps path to method + arg parser
  const routes = {
    '/extract': async (requestAI, body) => {
      const { data, schema, ...opts } = body;
      return requestAI.extract(data, schema, opts);
    },
    '/validate': async (requestAI, body) => {
      const { criteria, subject, reference, ...opts } = body;
      return requestAI.validate(criteria, subject, reference || null, opts);
    },
    '/summarize': async (requestAI, body) => {
      const { content, ...opts } = body;
      return requestAI.summarize(content, opts);
    },
    '/decide': async (requestAI, body) => {
      const { context, actions, ...opts } = body;
      delete opts.guard;
      return requestAI.decide(context, actions, opts);
    },
    '/chat': async (requestAI, body) => {
      const { prompt, ...opts } = body;
      // HTTP requests are stateless and always return a collected response.
      delete opts.stream;
      delete opts.trackHistory;
      return requestAI.chat(prompt, opts);
    },
    '/health': async () => ({
      status: 'ok',
      version: require('../package.json').version,
      engine: ai.defaultEngine,
      circuitBreaker: ai.resilience.getStats()
    })
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', c => {
        if (tooLarge) return;
        size += c.length;
        if (size > maxBodyBytes) {
          tooLarge = true;
          const error = new Error('Request body too large');
          error.status = 413;
          reject(error);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const raw = Buffer.concat(chunks).toString();
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          const error = new Error('Invalid JSON body');
          error.status = 400;
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJSON(res, status, data) {
    const body = JSON.stringify(data);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
    if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
    res.writeHead(status, headers);
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      sendJSON(res, 204, null);
      return;
    }

    // Auth check
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${apiKey}`) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // GET /health
    if (path === '/health' && req.method === 'GET') {
      try {
        const result = await routes['/health']();
        sendJSON(res, 200, result);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }

    // All other routes are POST
    if (req.method !== 'POST') {
      sendJSON(res, 405, { error: 'Method not allowed. Use POST.' });
      return;
    }

    const handler = routes[path];
    if (!handler) {
      sendJSON(res, 404, {
        error: `Unknown endpoint: ${path}`,
        available: Object.keys(routes)
      });
      return;
    }

    try {
      const body = await readBody(req);
      const requestAI = Object.create(ai);
      requestAI.context = new Map();
      requestAI.messages = [];
      requestAI.lastResult = null;
      const result = await handler(requestAI, body);
      sendJSON(res, result?.success === false ? 502 : 200, result);
    } catch (err) {
      const status = err.status || (err.name === 'CircuitBreakerError' ? 503 : 500);
      sendJSON(res, status, { error: err.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`nullprotocol server running on http://${host}:${port}`);
    console.log(`  POST /extract, /validate, /summarize, /decide, /chat`);
    console.log(`  GET  /health`);
    console.log('  Auth: Bearer token required');
  });

  // Attach the toolkit instance so callers can use it directly too
  server.ai = ai;
  server.routes = Object.keys(routes);

  return server;
}

module.exports = { serve };
