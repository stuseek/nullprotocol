/** Core library for model requests, structured output, and tool calls. */

const { ConfigLoader } = require('./config');
const { TelemetryClient } = require('./telemetry');
const { ActionExecutor, ConfirmationRequiredError } = require('./executor');
const { Resilience, CircuitBreakerError } = require('./resilience');
const { validateExtraction: validateSchema } = require('./schema');

// Global instance for functional usage
let globalInstance = null;

/**
 * Main AIToolkit Class
 */
/**
 * Industry presets for common use cases
 */
const PRESETS = {
  security: {
    basePrompt:
      'You are a senior security analyst with expertise in threat detection and incident response. Prioritize security over convenience. Be paranoid about potential threats.',
    temperature: 0.2,
    validateOutputs: true
  },

  devops: {
    basePrompt:
      'You are a DevOps engineer focused on reliability and automation. Balance uptime with development velocity. Consider scalability and monitoring.',
    temperature: 0.3,
    validateOutputs: false
  },

  customer_support: {
    basePrompt:
      'You are a customer service expert. Be empathetic and solution-oriented. Prioritize customer satisfaction while following company policies.',
    temperature: 0.4,
    validateOutputs: false
  },

  financial: {
    basePrompt:
      'You are a financial analyst with expertise in risk assessment and compliance. Be precise with numbers and conservative with recommendations. Consider regulatory requirements.',
    temperature: 0.1,
    validateOutputs: true,
    audit: true
  },

  medical: {
    basePrompt:
      'You are a medical professional assistant. Prioritize patient safety and privacy. Be conservative with health recommendations. Always suggest consulting healthcare providers for medical decisions.',
    temperature: 0.1,
    validateOutputs: true,
    audit: true
  },

  legal: {
    basePrompt:
      'You are a legal analyst. Be precise with terminology and conservative with interpretations. Consider jurisdictional differences. This is not legal advice.',
    temperature: 0.2,
    validateOutputs: true,
    audit: true
  },

  marketing: {
    basePrompt:
      'You are a marketing strategist. Focus on engagement, conversion, and brand consistency. Be creative but data-driven.',
    temperature: 0.6,
    validateOutputs: false
  },

  engineering: {
    basePrompt:
      'You are a software engineer. Focus on clean code, performance, and maintainability. Consider edge cases and error handling.',
    temperature: 0.3,
    validateOutputs: true
  }
};

class AIToolkit {
  constructor(options = {}) {
    // Apply preset if specified
    if (options.preset && PRESETS[options.preset]) {
      options = { ...PRESETS[options.preset], ...options };
    }

    // Store base prompt for context
    this.basePrompt = options.basePrompt || null;
    // Context store for stateful mode
    this.context = new Map();
    // Load configuration
    this.config = new ConfigLoader().load(options);

    this.telemetry = null;
    if (this.config.telemetry && (!this.config.telemetryKey || !this.config.telemetryEndpoint)) {
      throw new Error('Telemetry requires both telemetryKey and telemetryEndpoint');
    }
    if (this.config.telemetryKey && this.config.telemetryEndpoint && this.config.telemetry) {
      this.telemetry = new TelemetryClient({
        token: this.config.telemetryKey,
        endpoint: this.config.telemetryEndpoint,
        enabled: true
      });
    }

    this.engines = this.config.engines || {};
    this.defaultEngine = this.config.defaultEngine || 'openai';
    this.clients = {};
    this.initializeClients();

    this.executor = this.config.withExecutor ? new ActionExecutor() : null;
    this.validateOutputs = this.config.validateOutputs || false;

    this.debug = this.config.debug;

    this.lastResult = null;

    // Resilience: retry + circuit breaker + timeout
    const retryOpts = this.config.retry || {};
    this.resilience = new Resilience({
      maxRetries: retryOpts.maxRetries ?? 2,
      timeout: this.config.timeout ?? 30000,
      circuitBreakerThreshold: this.config.circuitBreaker?.threshold ?? 5,
      circuitBreakerResetMs: this.config.circuitBreaker?.resetAfterMs ?? 60000
    });

    // Conversation history
    this.messages = [];
    this.trackHistory = this.config.trackHistory ?? false;
    this.maxHistoryTokens = this.config.maxHistoryTokens ?? 50000;
    this.maxContextLength = null;
    if (this.config.maxContextLength !== undefined) {
      this.setMaxContextLength(this.config.maxContextLength);
    }
  }

  /**
   * Add context for stateful mode
   */
  addContext(key, value) {
    this.context.set(key, value);
    return this;
  }

  /**
   * Remove context
   */
  removeContext(key) {
    this.context.delete(key);
    return this;
  }

  /**
   * Clear all context
   */
  clearContext() {
    this.context.clear();
    return this;
  }

  /**
   * Add a message to conversation history
   */
  addMessage(role, content) {
    this.messages.push({ role, content });
    this._trimHistory();
    return this;
  }

  /**
   * Get conversation history
   */
  getHistory() {
    return [...this.messages];
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.messages = [];
    return this;
  }

  /** Set a character budget for the full request, including system and user text. */
  setMaxContextLength(maxChars) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new Error('maxContextLength must be a positive integer of characters');
    }
    this.maxContextLength = maxChars;
    return this;
  }

  _contextChars(value) {
    return typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
  }

  _fitContext(system, user, includeHistory, tools) {
    const fixedLength =
      this._contextChars(system) +
      this._contextChars(user) +
      (tools ? this._contextChars(tools) : 0);
    if (this.maxContextLength && fixedLength > this.maxContextLength) {
      throw new Error(
        `Current request exceeds maxContextLength (${this.maxContextLength} characters)`
      );
    }

    const history = includeHistory ? [...this.messages] : [];
    if (this.maxContextLength) {
      let totalLength =
        fixedLength +
        history.reduce((sum, message) => sum + this._contextChars(message.content), 0);
      while (history.length && totalLength > this.maxContextLength) {
        totalLength -= this._contextChars(history.shift().content);
        while (history[0]?.role === 'assistant') {
          totalLength -= this._contextChars(history.shift().content);
        }
      }
      if (includeHistory && history.length !== this.messages.length) {
        this.messages = history;
      }
    }
    return history;
  }

  /**
   * Trim history to stay within token budget (rough estimate: 4 chars = 1 token)
   */
  _trimHistory() {
    const charsPerToken = 4;
    const maxChars = this.maxHistoryTokens * charsPerToken;
    let totalChars = this.messages.reduce(
      (sum, message) => sum + this._contextChars(message.content),
      0
    );
    while (this.messages.length > 0 && totalChars > maxChars) {
      totalChars -= this._contextChars(this.messages.shift().content);
      while (this.messages[0]?.role === 'assistant') {
        totalChars -= this._contextChars(this.messages.shift().content);
      }
    }
  }

  /**
   * Get formatted context string
   */
  getContextString() {
    if (this.context.size === 0) {
      return '';
    }

    const contextParts = [];
    for (const [key, value] of this.context) {
      contextParts.push(`${key}: ${JSON.stringify(value)}`);
    }
    return `\nContext:\n${contextParts.join('\n')}`;
  }

  /**
   * Create a new instance with additional context
   */
  withContext(additionalPrompt) {
    const newPrompt = this.basePrompt
      ? `${this.basePrompt}\n\n${additionalPrompt}`
      : additionalPrompt;

    return new AIToolkit({
      ...this.config,
      basePrompt: newPrompt,
      engines: this.engines
    });
  }

  /**
   * Create specialized instance for specific domain
   */
  forDomain(domain) {
    if (!PRESETS[domain]) {
      throw new Error(`Unknown domain: ${domain}. Available: ${Object.keys(PRESETS).join(', ')}`);
    }

    return new AIToolkit({
      ...this.config,
      ...PRESETS[domain],
      engines: this.engines
    });
  }

  /**
   * Build messages with base prompt
   */
  buildMessages(systemPrompt, userPrompt, additionalContext = null) {
    let finalSystemPrompt = this.basePrompt
      ? `${this.basePrompt}\n\n${systemPrompt}`
      : systemPrompt;

    // Add stored context for stateful mode
    const contextString = this.getContextString();
    if (contextString) {
      finalSystemPrompt += contextString;
    }

    // Add additional context if provided
    if (additionalContext) {
      if (typeof additionalContext === 'string') {
        finalSystemPrompt += `\n\nAdditional context: ${additionalContext}`;
      } else {
        finalSystemPrompt += `\n\nAdditional context: ${JSON.stringify(additionalContext)}`;
      }
    }

    return {
      system: finalSystemPrompt,
      user: userPrompt
    };
  }

  initializeClients() {
    if (this.engines.openai) {
      try {
        const { OpenAI } = require('openai');
        this.clients.openai = new OpenAI({
          apiKey: this.engines.openai,
          baseURL: this.config.openaiBaseURL,
          maxRetries: 0
        });
      } catch {
        console.warn('OpenAI SDK not installed. Run: npm install openai');
      }
    }

    if (this.engines.anthropic) {
      try {
        const AnthropicModule = require('@anthropic-ai/sdk');
        const Anthropic = AnthropicModule.default || AnthropicModule;
        this.clients.anthropic = new Anthropic({
          apiKey: this.engines.anthropic,
          maxRetries: 0
        });
      } catch {
        console.warn('Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk');
      }
    }
  }

  /**
   * Resolve model name — supports aliases (fast, balanced, powerful) and per-engine defaults
   */
  _resolveModel(model, engine) {
    const defaults = { openai: 'gpt-4', anthropic: 'claude-sonnet-4-5-20250929' };
    return this.config.models?.[model] || model || this.config.models?.[engine] || defaults[engine];
  }

  async _requestModel(engine, client, params) {
    const response = await this.resilience.execute(signal => {
      const requestOptions = { signal, maxRetries: 0 };
      return engine === 'openai'
        ? client.chat.completions.create(params, requestOptions)
        : client.messages.create(params, requestOptions);
    });
    const usage = response?.usage;
    if (this.telemetry && usage) {
      this.telemetry.track('model_usage', {
        engine,
        model: params.model,
        inputTokens: usage.prompt_tokens ?? usage.input_tokens,
        outputTokens: usage.completion_tokens ?? usage.output_tokens
      });
    }
    return response;
  }

  /**
   * Format tools for the target provider
   */
  _formatToolsForProvider(tools, engine) {
    if (!tools || !Array.isArray(tools)) return undefined;

    if (engine === 'openai') {
      return tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
    }

    // Anthropic format
    return tools.map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} }
    }));
  }

  /**
   * Handle tool call loop for chat with tools
   */
  async _handleToolCalls(rawResponse, engine, client, requestParams, options) {
    const maxRounds = 10;
    const toolCalls = [];
    const allowedTools = new Set((options.tools || []).map(tool => tool.name));
    let currentResponse = rawResponse;

    for (let round = 0; round < maxRounds; round++) {
      let pendingCalls;

      if (engine === 'openai') {
        const choice = currentResponse.choices[0];
        if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
          return { text: choice.message.content || '', toolCalls };
        }
        pendingCalls = choice.message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          parameters: JSON.parse(tc.function.arguments || '{}')
        }));
      } else {
        // Anthropic
        if (currentResponse.stop_reason !== 'tool_use') {
          const textBlock = currentResponse.content.find(b => b.type === 'text');
          return { text: textBlock?.text || '', toolCalls };
        }
        const toolBlocks = currentResponse.content.filter(b => b.type === 'tool_use');
        pendingCalls = toolBlocks.map(b => ({
          id: b.id,
          name: b.name,
          parameters: b.input || {}
        }));
      }

      // Execute tool calls
      const results = [];
      for (const call of pendingCalls) {
        let result;
        try {
          result = allowedTools.has(call.name)
            ? await options.onToolCall(call.name, call.parameters)
            : { error: `Tool ${call.name} is not allowed` };
        } catch (err) {
          result = { error: err.message };
        }
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        toolCalls.push({ name: call.name, parameters: call.parameters, result });
        results.push({ id: call.id, result: resultStr });
      }

      // Send results back
      if (engine === 'openai') {
        const choice = currentResponse.choices[0];
        requestParams.messages.push(choice.message);
        for (const r of results) {
          requestParams.messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
        }
        currentResponse = await this._requestModel(engine, client, requestParams);
      } else {
        // Anthropic
        requestParams.messages.push({ role: 'assistant', content: currentResponse.content });
        requestParams.messages.push({
          role: 'user',
          content: results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.result
          }))
        });
        currentResponse = await this._requestModel(engine, client, requestParams);
      }
    }

    // The last model response can finish on the final allowed round.
    if (engine === 'openai') {
      if (currentResponse.choices[0].finish_reason !== 'tool_calls') {
        return { text: currentResponse.choices[0].message.content || '', toolCalls };
      }
    } else if (currentResponse.stop_reason !== 'tool_use') {
      const textBlock = currentResponse.content.find(b => b.type === 'text');
      return { text: textBlock?.text || '', toolCalls };
    }
    throw new Error(`Tool-call limit of ${maxRounds} rounds reached`);
  }

  async makeAIRequest(messages, options = {}) {
    const engine = options.engine || this.defaultEngine;
    const client = this.clients[engine];

    if (!client) {
      throw new Error(`AI engine ${engine} not configured. Pass an API key for this engine.`);
    }

    const start = Date.now();

    const sdkCall = async () => {
      const { system, user } = messages;
      const resolvedModel = this._resolveModel(options.model, engine);
      const history = this._fitContext(system, user, options.includeHistory, options.tools);

      // Build conversation messages including history
      const hasTools = options.tools && Array.isArray(options.tools) && options.onToolCall;

      switch (engine) {
        case 'openai': {
          const msgArray = [{ role: 'system', content: system }];
          msgArray.push(...history);
          if (Array.isArray(user)) msgArray.push(...user);
          else msgArray.push({ role: 'user', content: user });

          const params = {
            model: resolvedModel,
            messages: msgArray,
            temperature: options.temperature ?? this.config.temperature ?? 0.3,
            max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1000
          };

          if (hasTools) {
            params.tools = this._formatToolsForProvider(options.tools, 'openai');
          }

          const completion = await this._requestModel(engine, client, params);

          if (hasTools) {
            const result = await this._handleToolCalls(
              completion,
              'openai',
              client,
              params,
              options
            );
            return { text: result.text, toolCalls: result.toolCalls };
          }
          return completion.choices[0].message.content;
        }

        case 'anthropic': {
          const msgArray = [];
          msgArray.push(...history);
          if (Array.isArray(user)) msgArray.push(...user);
          else msgArray.push({ role: 'user', content: user });

          const params = {
            model: resolvedModel,
            system,
            messages: msgArray,
            max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1000,
            temperature: options.temperature ?? this.config.temperature ?? 0.3
          };

          if (hasTools) {
            params.tools = this._formatToolsForProvider(options.tools, 'anthropic');
          }

          const message = await this._requestModel(engine, client, params);

          if (hasTools) {
            const result = await this._handleToolCalls(
              message,
              'anthropic',
              client,
              params,
              options
            );
            return { text: result.text, toolCalls: result.toolCalls };
          }
          return message.content[0].text;
        }

        default:
          throw new Error(`Unknown engine: ${engine}`);
      }
    };

    try {
      const response = await sdkCall();

      // Track telemetry
      if (this.telemetry) {
        this.telemetry.track('ai_request', {
          engine,
          duration: Date.now() - start,
          success: true,
          operation: options.operation
        });
      }

      return response;
    } catch (error) {
      // Track error
      if (this.telemetry) {
        this.telemetry.track('ai_request', {
          engine,
          duration: Date.now() - start,
          success: false,
          error: error.message,
          operation: options.operation
        });
      }

      throw error;
    }
  }

  /**
   * Make a streaming request — returns an async generator
   */
  async *makeStreamRequest(messages, options = {}) {
    const engine = options.engine || this.defaultEngine;
    const client = this.clients[engine];

    if (!client) {
      throw new Error(`AI engine ${engine} not configured.`);
    }
    const { system, user } = messages;
    const resolvedModel = this._resolveModel(options.model, engine);
    const history = this._fitContext(system, user, options.includeHistory);
    const controller = new AbortController();
    const timeout = this.config.timeout ?? 30000;
    const timer =
      timeout > 0
        ? setTimeout(
            () => controller.abort(new Error(`AI stream timed out after ${timeout}ms`)),
            timeout
          )
        : null;

    try {
      switch (engine) {
        case 'openai': {
          const msgArray = [{ role: 'system', content: system }];
          msgArray.push(...history);
          if (Array.isArray(user)) msgArray.push(...user);
          else msgArray.push({ role: 'user', content: user });

          const stream = await client.chat.completions.create(
            {
              model: resolvedModel,
              messages: msgArray,
              temperature: options.temperature ?? this.config.temperature ?? 0.3,
              max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1000,
              stream: true
            },
            { signal: controller.signal, maxRetries: 0 }
          );

          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          }
          break;
        }

        case 'anthropic': {
          const msgArray = [];
          msgArray.push(...history);
          if (Array.isArray(user)) msgArray.push(...user);
          else msgArray.push({ role: 'user', content: user });

          const stream = client.messages.stream(
            {
              model: resolvedModel,
              system,
              messages: msgArray,
              max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1000,
              temperature: options.temperature ?? this.config.temperature ?? 0.3
            },
            { signal: controller.signal, maxRetries: 0 }
          );

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.text) {
              yield event.delta.text;
            }
          }
          break;
        }

        default:
          throw new Error(`Unknown engine: ${engine}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Parse JSON from AI response
   */
  parseJSON(response) {
    try {
      if (typeof response === 'object') {
        return response;
      }

      const cleaned = response
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const objectMatch = cleaned.match(/^\{[\s\S]*\}$/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }

      const arrayMatch = cleaned.match(/^\[[\s\S]*\]$/);
      if (arrayMatch) {
        return JSON.parse(arrayMatch[0]);
      }

      const firstObject = cleaned.indexOf('{');
      const firstArray = cleaned.indexOf('[');

      if (firstObject === -1 && firstArray === -1) {
        return JSON.parse(cleaned);
      }

      const isArray = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject);

      if (isArray) {
        let depth = 0;
        const start = firstArray;
        for (let i = firstArray; i < cleaned.length; i++) {
          if (cleaned[i] === '[') {
            depth++;
          }
          if (cleaned[i] === ']') {
            depth--;
          }
          if (depth === 0) {
            return JSON.parse(cleaned.substring(start, i + 1));
          }
        }
      } else {
        let depth = 0;
        const start = firstObject;
        for (let i = firstObject; i < cleaned.length; i++) {
          if (cleaned[i] === '{') {
            depth++;
          }
          if (cleaned[i] === '}') {
            depth--;
          }
          if (depth === 0) {
            return JSON.parse(cleaned.substring(start, i + 1));
          }
        }
      }

      return JSON.parse(cleaned);
    } catch (error) {
      if (this.debug) {
        console.error('JSON parse error:', error.message);
        console.error('Raw response:', response);
      }
      return { error: 'Failed to parse response' };
    }
  }

  /**
   * 📊 EXTRACT - Structure unstructured data
   */
  async extract(data, schema, options = {}) {
    const start = Date.now();
    const { additionalContext, ...apiOptions } = options;

    try {
      const systemPrompt =
        'Extract structured information according to the schema. Return valid JSON.';
      const userPrompt = `Data: ${JSON.stringify(data)}\n\nSchema: ${JSON.stringify(schema)}\n\nExtract the information and return JSON matching the schema.`;

      const messages = this.buildMessages(systemPrompt, userPrompt, additionalContext);

      const response = await this.makeAIRequest(messages, {
        ...apiOptions,
        operation: 'extract'
      });

      const extracted = this.parseJSON(response);
      const checked = await this.validateExtraction(extracted, schema);
      const validation = this.validateOutputs || options.validate ? checked : null;

      const result = {
        success: checked.isValid,
        data: checked.isValid ? extracted : null,
        confidence: checked.isValid ? this.calculateConfidence(extracted, schema) : 0,
        validation,
        ...(checked.isValid
          ? {}
          : { error: checked.issues.join('; ') || 'Invalid extraction result' })
      };

      // Store for chaining
      this.lastResult = result;

      // Telemetry
      if (this.telemetry) {
        this.telemetry.track('extract', {
          duration: Date.now() - start,
          schemaSize: Object.keys(schema).length,
          confidence: result.confidence,
          success: result.success
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        data: null,
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * ✅ VALIDATE - Assess against criteria
   */
  async validate(criteria, subject, reference = null, options = {}) {
    const start = Date.now();
    const { additionalContext, ...apiOptions } = options;

    try {
      // Support chaining - use last result if subject not provided
      if (typeof criteria === 'string' && !subject && this.lastResult) {
        subject = this.lastResult.data || this.lastResult;
      }

      const systemPrompt =
        'Validate the subject against criteria. Return JSON with score (0-1), reasoning, and recommendation.';
      const userPrompt = `Criteria: ${criteria}\n\nSubject: ${JSON.stringify(subject)}${reference ? `\n\nReference: ${JSON.stringify(reference)}` : ''}\n\nReturn: { score: 0-1, reasoning: "...", confidence: 0-1, recommendation: "pass/fail/conditional" }`;

      const messages = this.buildMessages(systemPrompt, userPrompt, additionalContext);

      const response = await this.makeAIRequest(messages, {
        ...apiOptions,
        operation: 'validate'
      });

      const validation = this.parseJSON(response);

      const valid =
        validation &&
        !validation.error &&
        typeof validation.score === 'number' &&
        validation.score >= 0 &&
        validation.score <= 1 &&
        typeof validation.reasoning === 'string';
      const result = {
        success: !!valid,
        score: valid ? validation.score : 0,
        reasoning: valid ? validation.reasoning : 'Invalid validation result',
        confidence: valid && typeof validation.confidence === 'number' ? validation.confidence : 0,
        recommendation: valid ? validation.recommendation : undefined,
        ...(valid ? {} : { error: 'Model returned an invalid validation result' })
      };

      // Store for chaining
      this.lastResult = result;

      // Telemetry
      if (this.telemetry) {
        this.telemetry.track('validate', {
          duration: Date.now() - start,
          score: result.score,
          confidence: result.confidence,
          success: result.success
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        score: 0,
        reasoning: error.message,
        confidence: 0
      };
    }
  }

  /**
   * 📝 SUMMARIZE - Synthesize key insights
   */
  async summarize(content, options = {}) {
    const start = Date.now();
    const { maxLength = 200, focus = 'key_insights', additionalContext, ...apiOptions } = options;

    try {
      // Support chaining - use last result if content not provided
      if (!content && this.lastResult) {
        content = this.lastResult.data || this.lastResult;
      }

      const systemPrompt = 'Create concise summaries focusing on actionable insights. Return JSON.';
      const userPrompt = `Content: ${JSON.stringify(content)}\n\nCreate a summary (max ${maxLength} chars) focusing on ${focus}.\n\nReturn: { summary: "...", keyPoints: [...], confidence: 0-1 }`;

      const messages = this.buildMessages(systemPrompt, userPrompt, additionalContext);

      const response = await this.makeAIRequest(messages, {
        ...apiOptions,
        operation: 'summarize'
      });

      const summary = this.parseJSON(response);

      const valid =
        summary &&
        !summary.error &&
        typeof summary.summary === 'string' &&
        summary.summary.length <= maxLength &&
        Array.isArray(summary.keyPoints) &&
        summary.keyPoints.every(point => typeof point === 'string');
      const result = {
        success: !!valid,
        summary: valid ? summary.summary : '',
        keyPoints: valid ? summary.keyPoints : [],
        confidence: valid && typeof summary.confidence === 'number' ? summary.confidence : 0,
        ...(valid ? {} : { error: 'Model returned an invalid summary' })
      };

      // Store for chaining
      this.lastResult = result;

      // Telemetry
      if (this.telemetry) {
        this.telemetry.track('summarize', {
          duration: Date.now() - start,
          inputLength: JSON.stringify(content).length,
          outputLength: result.summary.length,
          success: result.success
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        summary: '',
        keyPoints: [],
        error: error.message
      };
    }
  }

  /**
   * 🧠 DECIDE - Choose best action
   */
  async decide(context, actions, options = {}) {
    const start = Date.now();
    const { additionalContext, ...apiOptions } = options;

    try {
      // Support chaining - use last result if context not provided
      if (!context && this.lastResult) {
        context = this.lastResult.data || this.lastResult;
      }

      const systemPrompt =
        'Analyze context and choose the best action. Return JSON with your decision.';
      const userPrompt = `Context: ${JSON.stringify(context)}\n\nAvailable actions: ${JSON.stringify(actions)}\n\nReturn: { action: "chosen_action", reasoning: "...", confidence: 0-1, parameters: {} }`;

      const messages = this.buildMessages(systemPrompt, userPrompt, additionalContext);

      const response = await this.makeAIRequest(messages, {
        ...apiOptions,
        operation: 'decide'
      });

      const decision = this.parseJSON(response);

      const allowedActions = Array.isArray(actions)
        ? actions.map(action => (typeof action === 'string' ? action : action?.action))
        : [];
      const valid =
        decision &&
        !decision.error &&
        typeof decision.action === 'string' &&
        allowedActions.includes(decision.action) &&
        typeof decision.reasoning === 'string';
      const result = {
        success: !!valid,
        action: valid ? decision.action : null,
        reasoning: valid ? decision.reasoning : 'Invalid decision result',
        confidence: valid && typeof decision.confidence === 'number' ? decision.confidence : 0,
        parameters:
          valid && decision.parameters && typeof decision.parameters === 'object'
            ? decision.parameters
            : {},
        ...(valid
          ? {}
          : { error: 'Model selected an action outside the allowed list or returned invalid data' })
      };

      // Store for chaining
      this.lastResult = result;

      // Telemetry
      if (this.telemetry) {
        this.telemetry.track('decide', {
          duration: Date.now() - start,
          actionCount: actions.length,
          chosenAction: result.action,
          confidence: result.confidence,
          success: result.success
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        action: null,
        reasoning: error.message,
        confidence: 0
      };
    }
  }

  /**
   * 💬 CHAT - Conversational AI interaction
   * Generate free-form conversational responses
   * Supports tool use ({ tools, onToolCall }), streaming ({ stream: true }),
   * and conversation history ({ trackHistory: true })
   */
  async chat(prompt, options = {}) {
    const start = Date.now();
    const {
      additionalContext,
      systemPrompt,
      stream,
      collect,
      trackHistory,
      tools,
      onToolCall,
      ...apiOptions
    } = options;
    const shouldTrack = trackHistory ?? this.trackHistory;

    try {
      // Build system message
      const system =
        systemPrompt || 'You are a helpful AI assistant. Be conversational, clear, and concise.';

      // Support string or message array
      const userPrompt = Array.isArray(prompt)
        ? prompt.map(message => {
            if (
              !['user', 'assistant'].includes(message.role) ||
              typeof message.content !== 'string'
            ) {
              throw new Error(
                'Chat messages must have a user or assistant role and string content'
              );
            }
            return { role: message.role, content: message.content };
          })
        : typeof prompt === 'string'
          ? prompt
          : JSON.stringify(prompt);
      const promptText = typeof userPrompt === 'string' ? userPrompt : JSON.stringify(userPrompt);

      const messages = this.buildMessages(system, userPrompt, additionalContext);

      // Streaming path
      if (stream) {
        const generator = this.makeStreamRequest(messages, {
          ...apiOptions,
          includeHistory: shouldTrack,
          operation: 'chat'
        });

        if (collect) {
          let full = '';
          for await (const chunk of generator) {
            full += chunk;
          }

          if (!full.trim()) {
            return {
              success: false,
              message: null,
              confidence: null,
              error: 'Model returned an empty response'
            };
          }
          if (shouldTrack) {
            if (Array.isArray(userPrompt))
              userPrompt.forEach(message => this.addMessage(message.role, message.content));
            else this.addMessage('user', userPrompt);
            this.addMessage('assistant', full);
          }

          return { success: true, message: full, confidence: null };
        }

        return generator;
      }

      // Standard (non-streaming) path
      const requestOpts = {
        ...apiOptions,
        includeHistory: shouldTrack,
        operation: 'chat'
      };

      // Pass tools through if provided
      if (tools && onToolCall) {
        requestOpts.tools = tools;
        requestOpts.onToolCall = onToolCall;
      }

      const response = await this.makeAIRequest(messages, requestOpts);

      // Tool use returns { text, toolCalls }
      const isToolResponse = response && typeof response === 'object' && 'toolCalls' in response;
      const messageText = isToolResponse ? response.text : response;
      if (typeof messageText !== 'string' || !messageText.trim()) {
        throw new Error('Model returned an empty response');
      }

      const result = {
        success: true,
        message: messageText,
        confidence: null
      };

      if (isToolResponse) {
        result.toolCalls = response.toolCalls;
      }

      // Auto-track conversation history
      if (shouldTrack) {
        if (Array.isArray(userPrompt))
          userPrompt.forEach(message => this.addMessage(message.role, message.content));
        else this.addMessage('user', userPrompt);
        this.addMessage('assistant', messageText);
      }

      // Store for chaining
      this.lastResult = result;

      // Telemetry
      if (this.telemetry) {
        this.telemetry.track('chat', {
          duration: Date.now() - start,
          promptLength: promptText.length,
          responseLength: messageText?.length || 0,
          success: true
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        message: null,
        confidence: null,
        error: error.message
      };
    }
  }

  /**
   * 🔄 CHAIN - Compose multiple operations
   */
  async chain(...operations) {
    let result = null;

    for (const op of operations) {
      if (typeof op === 'function') {
        result = await op(result);
      } else if (Array.isArray(op)) {
        const [method, ...args] = op;
        if (typeof this[method] === 'function') {
          result = await this[method](...args, result);
        }
      }
    }

    return result;
  }

  /**
   * 🎯 PIPELINE - Create reusable pipeline
   */
  pipeline(...steps) {
    return async input => {
      let result = input;

      for (const step of steps) {
        if (typeof step === 'function') {
          result = await step.call(this, result);
        } else if (typeof step === 'object' && step.method) {
          const { method, args = [] } = step;
          result = await this[method](result, ...args);
        }
      }

      return result;
    };
  }

  /**
   * Execute action (if executor configured)
   */
  async execute(decision, options = {}) {
    if (!this.executor) {
      throw new Error('Executor not configured. Initialize with { withExecutor: true }');
    }

    // Support chaining - use last result if decision not provided
    if (!decision && this.lastResult && this.lastResult.action) {
      decision = this.lastResult;
    }

    return await this.executor.execute(decision, options);
  }

  /**
   * Register action for execution
   */
  registerAction(name, handler, metadata) {
    if (!this.executor) {
      this.executor = new ActionExecutor();
    }

    return this.executor.register(name, handler, metadata);
  }

  /**
   * Validate extraction result
   */
  async validateExtraction(extracted, schema) {
    return validateSchema(extracted, schema);
  }

  /**
   * Calculate extraction confidence
   */
  calculateConfidence(extracted, schema) {
    if (!extracted || extracted.error) {
      return 0;
    }

    const schemaKeys = Object.keys(schema.properties || schema);
    if (schemaKeys.length === 0) {
      return 0;
    }

    let filledCount = 0;
    const totalCount = schemaKeys.length;

    for (const key of schemaKeys) {
      const value = extracted[key];
      if (value !== null && value !== undefined && value !== '') {
        filledCount++;
      }
    }

    return filledCount / totalCount;
  }
}

/**
 * Initialize global instance for functional usage
 */
function getGlobalInstance() {
  if (!globalInstance) {
    globalInstance = new AIToolkit();
  }
  return globalInstance;
}

/**
 * Functional exports - can be used directly
 */
const extract = (data, schema, options) => getGlobalInstance().extract(data, schema, options);
const validate = (criteria, subject, reference, options) =>
  getGlobalInstance().validate(criteria, subject, reference, options);
const summarize = (content, options) => getGlobalInstance().summarize(content, options);
const decide = (context, actions, options) => getGlobalInstance().decide(context, actions, options);
const chat = (prompt, options) => getGlobalInstance().chat(prompt, options);
const execute = decision => getGlobalInstance().execute(decision);

/**
 * Configure global instance
 */
function configure(options) {
  globalInstance = new AIToolkit(options);
  return globalInstance;
}

/**
 * Factory functions for creating specialized instances
 */
const createAI = {
  security: () => new AIToolkit({ preset: 'security' }),
  devops: () => new AIToolkit({ preset: 'devops' }),
  support: () => new AIToolkit({ preset: 'customer_support' }),
  financial: () => new AIToolkit({ preset: 'financial' }),
  medical: () => new AIToolkit({ preset: 'medical' }),
  legal: () => new AIToolkit({ preset: 'legal' }),
  marketing: () => new AIToolkit({ preset: 'marketing' }),
  engineering: () => new AIToolkit({ preset: 'engineering' })
};

// Export everything
module.exports = AIToolkit;
module.exports.NullProtocol = AIToolkit;
module.exports.AIToolkit = AIToolkit;
module.exports.extract = extract;
module.exports.validate = validate;
module.exports.summarize = summarize;
module.exports.decide = decide;
module.exports.chat = chat;
module.exports.execute = execute;
module.exports.configure = configure;
module.exports.createAI = createAI;
module.exports.presets = PRESETS;
module.exports.Resilience = Resilience;
module.exports.CircuitBreakerError = CircuitBreakerError;
module.exports.ConfirmationRequiredError = ConfirmationRequiredError;
module.exports.serve = function (options) {
  return require('./server').serve(options);
};

// Default export
module.exports.default = AIToolkit;
