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
const crypto = require('crypto');

function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

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
      const { data, schema } = body;
      return requestAI.extract(data, schema, {});
    },
    '/validate': async (requestAI, body) => {
      const { criteria, subject, reference } = body;
      return requestAI.validate(criteria, subject, reference || null, {});
    },
    '/summarize': async (requestAI, body) => {
      const { content } = body;
      return requestAI.summarize(content, {});
    },
    '/decide': async (requestAI, body) => {
      const { context, actions } = body;
      return requestAI.decide(context, actions, {});
    },
    '/chat': async (requestAI, body) => {
      const { prompt } = body;
      return requestAI.chat(prompt, {});
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
    if (!auth?.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), apiKey)) {
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
        sendJSON(res, 500, { error: 'Internal error' });
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJSON(res, 400, { error: 'Invalid request body' });
        return;
      }
      const requestAI = Object.create(ai);
      requestAI.context = new Map();
      requestAI.messages = [];
      requestAI.lastResult = null;
      const result = await handler(requestAI, body);
      if (result?.success === false) {
        sendJSON(res, 502, { success: false, error: 'agent_failed' });
        return;
      }
      if (result?.toolCalls) {
        const { toolCalls: _toolCalls, ...publicResult } = result;
        sendJSON(res, 200, publicResult);
        return;
      }
      sendJSON(res, 200, result);
    } catch (err) {
      const status = err.status || (err.name === 'CircuitBreakerError' ? 503 : 500);
      sendJSON(res, status, {
        error:
          status === 413
            ? 'Request body too large'
            : status === 400
              ? 'Invalid JSON body'
              : 'Internal error'
      });
    }
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

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
