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
    this.path = options.path || '/api/telemetry';
    if (
      options.path !== undefined &&
      (typeof options.path !== 'string' ||
        !options.path.startsWith('/') ||
        options.path.startsWith('//') ||
        /[\\#]/.test(options.path))
    ) {
      throw new Error('Telemetry path must start with one slash and contain no fragment');
    }
    this.enabled = options.enabled !== false && !!this.token && !!this.endpoint;
    this.url = null;
    if (this.enabled) {
      const endpoint = new URL(this.endpoint);
      if (endpoint.protocol !== 'https:') throw new Error('Telemetry endpoint must use HTTPS');
      this.url = new URL(this.path, endpoint);
      if (this.url.origin !== endpoint.origin) {
        throw new Error('Telemetry path must stay on the endpoint origin');
      }
    }
    this.sessionId = this.generateSessionId();
    this.agentId = options.agentId || 'default-agent';
    this.environment = options.environment || null;
    this.currentRunId = options.currentRunId || null;
    this.queue = [];
    this.flushInterval = null;
    this.flushing = null;
    this.retryAt = 0;
    this.failures = 0;
    this.droppedEvents = 0;

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
    try {
      const runId = this.currentRunId?.();
      const safeData = {
        event,
        eventId: crypto.randomUUID(),
        agentId: this.agentId,
        ...(this.environment ? { environment: this.environment } : {}),
        ...(runId ? { runId } : {}),
        timestamp: Date.now(),
        sessionId: this.sessionId,
        data: this.sanitizeData(data)
      };

      if (Buffer.byteLength(JSON.stringify(safeData)) > 4096 || this.queue.length >= 1000) {
        this.droppedEvents++;
        return;
      }
      this.queue.push(safeData);

      if (this.queue.length >= 50) {
        void this.flush();
      }
    } catch {
      // Observability must not turn a successful model call into an application error.
      this.droppedEvents++;
    }
  }

  trackTrace(runId, data) {
    if (!this.enabled) return;
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return;
      const operations = ['extract', 'validate', 'summarize', 'decide', 'chat'];
      if (!operations.includes(data.operation)) return;
      const codes = new Set([
        'provider_error',
        'rate_limited',
        'timeout',
        'aborted',
        'schema_mismatch',
        'guard_rejected',
        'guard_error',
        'guard_timeout',
        'tool_error',
        'config_error',
        'internal'
      ]);
      const count = value =>
        Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
      const steps = data.steps.slice(0, 24).map(step => ({
        kind: step.kind,
        offset: count(step.offset),
        duration: count(step.duration),
        success: !!step.success,
        ...(typeof step.model === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/+@-]{0,127}$/.test(step.model)
          ? { model: step.model }
          : {}),
        ...(step.inputTokens !== undefined ? { inputTokens: count(step.inputTokens) } : {}),
        ...(step.outputTokens !== undefined ? { outputTokens: count(step.outputTokens) } : {}),
        ...(codes.has(step.errorCode) ? { errorCode: step.errorCode } : {})
      }));
      const hash = crypto.createHash('sha256').update(`run.trace:${runId}`).digest('hex');
      const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const safe = {
        event: 'run.trace',
        eventId,
        runId,
        agentId: this.agentId,
        ...(this.environment ? { environment: this.environment } : {}),
        timestamp: Date.now(),
        data: {
          operation: data.operation,
          status: ['completed', 'failed', 'aborted'].includes(data.status) ? data.status : 'failed',
          duration: count(data.duration),
          stepsTotal: count(data.stepsTotal),
          truncated: !!data.truncated,
          steps
        }
      };
      while (Buffer.byteLength(JSON.stringify(safe)) > 4096 && steps.length) {
        steps.pop();
        safe.data.truncated = true;
      }
      if (this.queue.length >= 1000 || Buffer.byteLength(JSON.stringify(safe)) > 4096) {
        this.droppedEvents++;
        return;
      }
      this.queue.push(safe);
      if (this.queue.length >= 50) void this.flush();
    } catch {
      this.droppedEvents++;
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
      'outputLength',
      'errorCode'
    ];

    const sanitized = {};
    for (const key of allowed) {
      if (safe[key] !== undefined) {
        sanitized[key] = safe[key];
      }
    }

    for (const key of ['confidence', 'score']) {
      if (typeof sanitized[key] === 'number' && Number.isFinite(sanitized[key])) {
        sanitized[key] = Math.max(0, Math.min(key === 'confidence' ? 1 : 100, sanitized[key]));
      }
    }
    return sanitized;
  }

  async flush(force = false) {
    if (force) this.retryAt = 0;
    if (!this.enabled || !this.queue.length || Date.now() < this.retryAt) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length && Date.now() >= this.retryAt) {
        const batch = this.queue.slice(0, 50);
        try {
          const response = await this.send(batch);
          this.queue.splice(0, batch.length);
          this.failures = 0;
          try {
            this.droppedEvents += JSON.parse(response.body)?.rejected?.length || 0;
          } catch {
            /* optional response */
          }
        } catch (error) {
          if (process.env.AI_DEBUG === 'true') console.error('Telemetry error:', error.message);
          if (error.status >= 400 && error.status < 500 && error.status !== 429) {
            this.queue.splice(0, batch.length);
            this.droppedEvents += batch.length;
            continue;
          }
          this.failures++;
          const delay =
            error.status === 429 && error.retryAfter
              ? error.retryAfter * 1000
              : Math.min(60000, 1000 * 2 ** Math.min(this.failures, 6));
          this.retryAt = Date.now() + delay;
          break;
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  send(events) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ events });

      const url = this.url;
      if (url.protocol !== 'https:') {
        reject(new Error('Telemetry endpoint must use HTTPS'));
        return;
      }
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
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
            resolve({ status: res.statusCode, body });
          } else {
            const error = new Error(`Telemetry failed: ${res.statusCode}`);
            error.status = res.statusCode;
            error.retryAfter = Number(res.headers['retry-after']) || 0;
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Telemetry request timed out')));
      req.write(data);
      req.end();
    });
  }

  async destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    if (this.flushing) await this.flushing;
    await this.flush(true);
  }
}

module.exports = { TelemetryClient };
