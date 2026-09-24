/**
 * AI Toolkit TypeScript Definitions
 */

export interface BaseOptions {
  engine?: 'openai' | 'anthropic';
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Additional context for a single call (string or arbitrary object) */
  additionalContext?: string | Record<string, unknown>;
}

export interface RetryOptions {
  maxRetries?: number;
}

export interface CircuitBreakerOptions {
  threshold?: number;
  resetAfterMs?: number;
}

export interface ModelAliases {
  openai?: string;
  anthropic?: string;
  fast?: string;
  balanced?: string;
  powerful?: string;
  [alias: string]: string | undefined;
}

export interface AIToolkitOptions {
  engines?: {
    openai?: string;
    anthropic?: string;
  };
  defaultEngine?: 'openai' | 'anthropic';
  basePrompt?: string;
  preset?: 'security' | 'devops' | 'customer_support' | 'financial' | 'medical' | 'legal' | 'marketing' | 'engineering';
  temperature?: number;
  maxTokens?: number;
  validateOutputs?: boolean;
  withExecutor?: boolean;
  /** Base URL for an OpenAI compatible API, including a local server. */
  openaiBaseURL?: string;
  token?: string;
  telemetryKey?: string;
  /** HTTPS service origin; any path in this URL is ignored. */
  telemetryEndpoint?: string;
  /** Optional ingest path on telemetryEndpoint (default /api/telemetry). */
  telemetryPath?: string;
  telemetry?: boolean;
  /** Stable identity in telemetry. Calls and sessions do not create new agents. */
  agentId?: string;
  /** Optional label checked against the Space ingest key. */
  environment?: string;
  debug?: boolean;
  /** Model aliases and per-engine defaults */
  models?: ModelAliases;
  /** Retry configuration */
  retry?: RetryOptions;
  /** Request timeout in milliseconds (default 30000) */
  timeout?: number;
  /** Circuit breaker configuration */
  circuitBreaker?: CircuitBreakerOptions;
  /** Enable automatic conversation history tracking for chat() */
  trackHistory?: boolean;
  /** Max tokens to keep in conversation history (default 50000) */
  maxHistoryTokens?: number;
  /** Character budget for system text, current input, tool definitions, and included history. */
  maxContextLength?: number;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export interface ToolCallResult {
  name: string;
  parameters: Record<string, any>;
  result: any;
}

export interface ExtractOptions extends BaseOptions {
  validate?: boolean;
}

export interface ValidateOptions extends BaseOptions {}

export interface SummarizeOptions extends BaseOptions {
  maxLength?: number;
  focus?: string;
}

export interface DecideOptions extends BaseOptions {}

export interface ChatOptions extends BaseOptions {
  /** Custom system prompt for the conversation */
  systemPrompt?: string;
  /** Tools available for the AI to call */
  tools?: ToolDefinition[];
  /** Callback invoked when the AI makes a tool call */
  onToolCall?: (name: string, parameters: Record<string, any>, context?: { principal?: string; agentId?: string; sessionId?: string; runId?: string }) => any | Promise<any>;
  /** Enable streaming mode — returns async generator */
  stream?: boolean;
  /** When streaming, collect all chunks and return a ChatResult instead of a generator */
  collect?: boolean;
  /** Override constructor-level trackHistory for this call */
  trackHistory?: boolean;
}

export interface ExtractResult {
  success: boolean;
  data: any | null;
  confidence: number;
  validation?: any;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  score: number;
  reasoning: string;
  confidence: number;
  recommendation: string;
  error?: string;
}

export interface SummarizeResult {
  success: boolean;
  summary: string;
  keyPoints: string[];
  confidence: number;
  error?: string;
}

export interface DecideResult {
  success: boolean;
  action: string | null;
  reasoning: string;
  confidence: number;
  parameters: Record<string, any>;
  error?: string;
}

export interface ChatResult {
  success: boolean;
  message: string | null;
  confidence: number | null;
  toolCalls?: ToolCallResult[];
  error?: string;
}

export interface ResilienceStats {
  failures: number;
  tripped: boolean;
  totalSkipped: number;
  tripTime: number | null;
}

export declare class CircuitBreakerError extends Error {
  name: 'CircuitBreakerError';
  failures: number;
  totalSkipped: number;
}

export declare class ConfirmationRequiredError extends Error {
  name: 'ConfirmationRequiredError';
  action: string;
}

export declare class Resilience {
  constructor(options?: {
    maxRetries?: number;
    timeout?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerResetMs?: number;
  });
  execute<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  isTripped(): boolean;
  reset(): void;
  recordSuccess(): void;
  recordFailure(): void;
  getStats(): ResilienceStats;
}

export declare class AIToolkit {
  constructor(options?: AIToolkitOptions);

  /** Resilience instance (retry + circuit breaker + timeout) */
  resilience: Resilience;

  /** Conversation history messages */
  messages: Array<{ role: string; content: string }>;

  /**
   * Add context for stateful mode
   */
  addContext(key: string, value: any): this;

  /**
   * Remove context
   */
  removeContext(key: string): this;

  /**
   * Clear all context
   */
  clearContext(): this;

  /**
   * Add a message to conversation history
   */
  addMessage(role: string, content: string): this;

  /**
   * Get a copy of the conversation history
   */
  getHistory(): Array<{ role: string; content: string }>;

  /**
   * Clear conversation history
   */
  clearHistory(): this;

  /** Set the character budget for future model requests. */
  setMaxContextLength(maxChars: number): this;

  /**
   * Extract structured information from unstructured data
   */
  extract(
    data: any,
    schema: Record<string, any>,
    options?: ExtractOptions
  ): Promise<ExtractResult>;

  /**
   * Validate data against criteria
   */
  validate(
    criteria: string,
    subject: any,
    reference?: any,
    options?: ValidateOptions
  ): Promise<ValidateResult>;

  /**
   * Summarize content into key insights
   */
  summarize(
    content: any,
    options?: SummarizeOptions
  ): Promise<SummarizeResult>;

  /**
   * Make intelligent decision from available actions
   */
  decide(
    context: any,
    actions: string[],
    options?: DecideOptions
  ): Promise<DecideResult>;

  /**
   * Conversational AI interaction with optional tool use and streaming
   */
  chat(
    prompt: string | Array<{ role: string; content: string }>,
    options?: ChatOptions & { stream?: false; collect?: false }
  ): Promise<ChatResult>;
  chat(
    prompt: string | Array<{ role: string; content: string }>,
    options: ChatOptions & { stream: true; collect: true }
  ): Promise<ChatResult>;
  chat(
    prompt: string | Array<{ role: string; content: string }>,
    options: ChatOptions & { stream: true; collect?: false }
  ): Promise<AsyncGenerator<string, void, unknown>>;

  /**
   * Execute registered action
   */
  execute(decision: DecideResult, options?: { confirm?: (action: string, parameters: Record<string, any>) => boolean | Promise<boolean> }): Promise<any>;

  /**
   * Register action for execution
   */
  registerAction(name: string, handler: Function, metadata?: any): this;

  /**
   * Create pipeline for chaining operations
   */
  pipeline(...steps: Function[]): (input: any) => Promise<any>;

  /**
   * Create new instance with additional context
   */
  withContext(additionalPrompt: string): AIToolkit;

  /**
   * Create specialized instance for domain
   */
  forDomain(domain: string): AIToolkit;
}

/** Preferred public name; AIToolkit remains as a compatibility alias. */
export { AIToolkit as NullProtocol };

// Stateless function exports
export function extract(
  data: any,
  schema: Record<string, any>,
  options?: ExtractOptions
): Promise<ExtractResult>;

export function validate(
  criteria: string,
  subject?: any,
  reference?: any,
  options?: ValidateOptions
): Promise<ValidateResult>;

export function summarize(
  content?: any,
  options?: SummarizeOptions
): Promise<SummarizeResult>;

export function decide(
  context?: any,
  actions?: string[],
  options?: DecideOptions
): Promise<DecideResult>;

export function chat(
  prompt: string | Array<{ role: string; content: string }>,
  options?: ChatOptions
): Promise<ChatResult>;

export function execute(
  decision: DecideResult,
  options?: { confirm?: (action: string, parameters: Record<string, any>) => boolean | Promise<boolean> }
): Promise<any>;

export function configure(options: AIToolkitOptions): AIToolkit;

export const presets: Record<string, any>;

export const createAI: {
  security(): AIToolkit;
  devops(): AIToolkit;
  support(): AIToolkit;
  financial(): AIToolkit;
  medical(): AIToolkit;
  legal(): AIToolkit;
  marketing(): AIToolkit;
  engineering(): AIToolkit;
};

export interface ServeOptions extends AIToolkitOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Bind address (default: 127.0.0.1) */
  host?: string;
  /** Required Bearer token auth */
  apiKey?: string;
  /** Optional CORS origin */
  cors?: string;
  /** Maximum JSON request size in bytes (default: 1048576) */
  maxBodyBytes?: number;
}

import type { Server } from 'http';

export interface AIServer extends Server {
  /** The AIToolkit instance powering the server */
  ai: AIToolkit;
  /** Available route paths */
  routes: string[];
}

/**
 * Start an HTTP microservice exposing all AI primitives as endpoints.
 * POST /extract, /validate, /summarize, /decide, /chat
 * GET  /health
 */
export function serve(options?: ServeOptions): AIServer;

export interface AgentDefinition extends AIToolkitOptions {
  id: string;
  mode: 'stateless' | 'stateful';
  description?: string;
  tools?: ToolDefinition[];
  schemas?: Record<string, Record<string, any>>;
  onToolCall?: (name: string, parameters: Record<string, any>, context?: { principal?: string; agentId?: string; sessionId?: string; runId?: string }) => any | Promise<any>;
  callOptions?: BaseOptions;
  maxHistoryMessages?: number;
}

export interface SessionState {
  messages: Array<{ role: string; content: string }>;
  context: Record<string, unknown>;
}

export interface SessionRef {
  id: string;
  agent: string;
  principal: string;
}

export interface SessionStore {
  create(ref: Omit<SessionRef, 'id'>, state?: SessionState, ttlMs?: number): Promise<string>;
  acquire(ref: SessionRef, leaseMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
  commit(ref: SessionRef, lease: string, state: SessionState, ttlMs?: number): Promise<boolean>;
  release(ref: SessionRef, lease: string): Promise<void>;
  renew(ref: SessionRef, lease: string, leaseMs?: number): Promise<boolean>;
  clear(ref: SessionRef, part?: 'all' | 'history' | 'context'): Promise<string>;
  delete(ref: SessionRef): Promise<string>;
}

export declare class MemorySessionStore implements SessionStore {
  constructor(options?: { maxSessions?: number });
  create(ref: Omit<SessionRef, 'id'>, state?: SessionState, ttlMs?: number): Promise<string>;
  acquire(ref: SessionRef, leaseMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
  commit(ref: SessionRef, lease: string, state: SessionState, ttlMs?: number): Promise<boolean>;
  release(ref: SessionRef, lease: string): Promise<void>;
  renew(ref: SessionRef, lease: string, leaseMs?: number): Promise<boolean>;
  clear(ref: SessionRef, part?: 'all' | 'history' | 'context'): Promise<string>;
  delete(ref: SessionRef): Promise<string>;
}

export declare class PostgresSessionStore implements SessionStore {
  constructor(pool: { query(sql: string, values?: unknown[]): Promise<any> });
  create(ref: Omit<SessionRef, 'id'>, state?: SessionState, ttlMs?: number): Promise<string>;
  acquire(ref: SessionRef, leaseMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
  commit(ref: SessionRef, lease: string, state: SessionState, ttlMs?: number): Promise<boolean>;
  release(ref: SessionRef, lease: string): Promise<void>;
  renew(ref: SessionRef, lease: string, leaseMs?: number): Promise<boolean>;
  clear(ref: SessionRef, part?: 'all' | 'history' | 'context'): Promise<string>;
  delete(ref: SessionRef): Promise<string>;
  purgeExpired(): Promise<number>;
}

export interface AgentServerOptions {
  agents: AgentDefinition[] | Record<string, Omit<AgentDefinition, 'id'>>;
  apiKey?: string;
  authenticate?: (request: import('http').IncomingMessage) => Promise<{ principal: string; agents?: string[]; canManage?: boolean } | null>;
  store?: SessionStore;
  only?: string[];
  port?: number;
  host?: string;
  maxConcurrentTurns?: number;
  maxBodyBytes?: number;
  handleSignals?: boolean;
}

export function defineAgent(options: AgentDefinition): AgentDefinition;
export function serveAgents(options: AgentServerOptions): Server;
export function serve(options: AgentServerOptions): Server;

export default AIToolkit;
