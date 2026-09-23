/**
 * Telemetry Client for AI Toolkit
 * Sends opt-in usage metadata without prompt or response content.
 */

const https = require('https');
const crypto = require('crypto');

class TelemetryClient {
  constructor(options = {}) {
    this.token = options.token;
    this.endpoint = options.endpoint || null;
    this.enabled = options.enabled !== false && !!this.token && !!this.endpoint;
    if (this.enabled && new URL(this.endpoint).protocol !== 'https:') {
      throw new Error('Telemetry endpoint must use HTTPS');
    }
    this.sessionId = this.generateSessionId();
    this.queue = [];
    this.flushInterval = null;

    if (this.enabled) {
      // Flush every 10 seconds
      this.flushInterval = setInterval(() => this.flush(), 10000);
      this.flushInterval.unref();
    }
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  track(event, data = {}) {
    if (!this.enabled) {
      return;
    }

    const safeData = {
      event,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      data: this.sanitizeData(data)
    };

    this.queue.push(safeData);
    if (this.queue.length > 1000) this.queue.shift();

    // Flush if queue is large
    if (this.queue.length >= 50) {
      this.flush();
    }
  }

  sanitizeData(data) {
    const safe = { ...data };

    delete safe.input;
    delete safe.output;
    delete safe.content;
    delete safe.subject;
    delete safe.context;
    delete safe.result;

    const allowed = [
      'duration',
      'success',
      'confidence',
      'score',
      'operation',
      'engine',
      'model',
      'inputTokens',
      'outputTokens',
      'schemaSize',
      'actionCount',
      'inputLength',
      'outputLength'
    ];

    const sanitized = {};
    for (const key of allowed) {
      if (safe[key] !== undefined) {
        sanitized[key] = safe[key];
      }
    }

    return sanitized;
  }

  async flush() {
    if (!this.enabled || this.queue.length === 0) {
      return;
    }

    const events = [...this.queue];
    this.queue = [];

    try {
      await this.send(events);
    } catch (error) {
      if (process.env.AI_DEBUG === 'true') {
        console.error('Telemetry error:', error.message);
      }
      this.queue.unshift(...events);
      if (this.queue.length > 1000) this.queue.length = 1000;
    }
  }

  send(events) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ events });

      const url = new URL('/api/telemetry', this.endpoint);
      if (url.protocol !== 'https:') {
        reject(new Error('Telemetry endpoint must use HTTPS'));
        return;
      }
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${this.token}`
        }
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else if (res.statusCode === 429) {
            reject(new Error('Rate limit exceeded'));
          } else {
            reject(new Error(`Telemetry failed: ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Telemetry request timed out')));
      req.write(data);
      req.end();
    });
  }

  async destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

module.exports = { TelemetryClient };
