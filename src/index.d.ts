// TypeScript definitions for nullprotocol.

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
  /** Consecutive failed requests that open the breaker (default 5). */
  threshold?: number;
  /** How long it rejects requests before closing again (default 60000). */
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
  /** A config file to load, or `false` to skip config files. */
  configFile?: string | false;
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
  /**
   * Extra model turns allowed to fix an unusable reply: invalid JSON, a
   * schema mismatch, or an action that is not offered. The model sees its
   * reply and the exact problem. 0 to 3; default 1 (constructor option).
   * A schema-valid but wrong value is not detected or repaired.
   */
  repairAttempts?: number;
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
  /** Opt-in Team run timeline: one metadata event per eligible call or consumed stream, including failures and cancellations. Counts toward the Space's daily event limit. */
  telemetryTimeline?: boolean;
  /** Separate Space-scoped key for explicit shared context reads and writes. */
  spaceContextKey?: string;
  /** HTTPS origin of the NullProtocol API. */
  spaceContextEndpoint?: string;
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
  /**
   * Extra model turns allowed to fix an unusable reply: invalid JSON, a
   * schema mismatch, or an action that is not offered. The model sees its
   * reply and the exact problem. 0 to 3; default 1 (constructor option).
   * A schema-valid but wrong value is not detected or repaired.
   */
  repairAttempts?: number;
}

export interface ValidateOptions extends BaseOptions {}

export interface SummarizeOptions extends BaseOptions {
  maxLength?: number;
  focus?: string;
}

export type DecisionAction = string | { action: string; [key: string]: unknown };

export interface DecideOptions extends BaseOptions {
  /** Application-owned check. Only true accepts a structurally valid model decision. Treat input.context as untrusted for HTTP agents. */
  guard?: (
    decision: DecideResult,
    input: { context: any; actions: DecisionAction[] },
    runtime: { principal?: string; agentId?: string; sessionId?: string; runId?: string; signal: AbortSignal }
  ) => boolean | Promise<boolean>;
  /** Guard timeout in milliseconds (default 30000, maximum 120000). */
  guardTimeoutMs?: number;
  /**
   * Extra model turns allowed to fix an unusable reply: invalid JSON, a
   * schema mismatch, or an action that is not offered. The model sees its
   * reply and the exact problem. 0 to 3; default 1 (constructor option).
   * A schema-valid but wrong value is not detected or repaired.
   */
  repairAttempts?: number;
}

export interface ChatOptions extends BaseOptions {
  /** Custom system prompt for the conversation */
  systemPrompt?: string;
  /** Tools available for the AI to call */
  tools?: ToolDefinition[];
  /** Callback invoked when the AI makes a tool call */
  onToolCall?: (name: string, parameters: Record<string, any>, context?: { principal?: string; agentId?: string; sessionId?: string; runId?: string; callId?: string; signal?: AbortSignal }) => any | Promise<any>;
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
  /** Model calls used, including repair turns; also set when the result failed. Each call's tokens are in the trace and model_usage telemetry. */
  attempts?: number;
  /** True when a repair turn turned an unusable reply into an accepted one. */
  repaired?: boolean;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  score: number;
  reasoning: string;
  confidence: number;
  recommendation?: 'pass' | 'fail' | 'conditional';
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
  /** Model-selected action when the application guard rejected it. Never execute it. */
  rejectedAction?: string;
  /** Set when an application guard rejects or cannot finish checking a decision. */
  errorCode?: 'guard_rejected' | 'guard_error' | 'guard_timeout';
  /** Model calls used, including repair turns; also set when the result failed. Each call's tokens are in the trace and model_usage telemetry. */
  attempts?: number;
  /** True when a repair turn turned an unusable reply into an accepted one. */
  repaired?: boolean;
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

export interface SpaceContextDocument<T = unknown> {
  value: T;
  version: string;
  expires_at: string | null;
  updated_at: string;
}

export declare class SpaceContextError extends Error {
  status: number;
  code: string;
}

export declare class SpaceContextClient {
  constructor(options: { key: string; endpoint: string; fetchImpl?: typeof fetch });
  get<T = unknown>(namespace: string, key: string): Promise<SpaceContextDocument<T> | null>;
  put<T = unknown>(namespace: string, key: string, value: T, options: { ifVersion: string | null; ttlSeconds?: number | null }): Promise<SpaceContextDocument<T>>;
  delete(namespace: string, key: string, ifVersion: string): Promise<void>;
}

export declare class Resilience {
  constructor(options?: {
    maxRetries?: number;
    timeout?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerResetMs?: number;
  });
  execute<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }
  ): Promise<T>;
  isTripped(): boolean;
  reset(): void;
  recordSuccess(): void;
  recordFailure(): void;
  getStats(): ResilienceStats;
}

export declare class AIToolkit {
  constructor(options?: AIToolkitOptions);

  /** Optional, explicit Space store. Values are never added to model prompts automatically. */
  spaceContext: SpaceContextClient | null;

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
    actions: DecisionAction[],
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
  actions?: DecisionAction[],
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
  onToolCall?: (name: string, parameters: Record<string, any>, context?: { principal?: string; agentId?: string; sessionId?: string; runId?: string; callId?: string; signal?: AbortSignal }) => any | Promise<any>;
  callOptions?: BaseOptions & Pick<DecideOptions, 'guard' | 'guardTimeoutMs'> & Pick<ChatOptions, 'systemPrompt'>;
  /** Defaults to 8,192 rough tokens in the named HTTP service. */
  maxHistoryTokens?: number;
  /** At least 2; history retains whole user/assistant exchanges within this cap. */
  maxHistoryMessages?: number;
  operations?: Array<'chat' | 'decide' | 'extract' | 'summarize' | 'validate'>;
  exposeToolCalls?: boolean;
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
  acquire(ref: SessionRef, leaseMs?: number, ttlMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
  commit(ref: SessionRef, lease: string, state: SessionState, ttlMs?: number): Promise<boolean>;
  release(ref: SessionRef, lease: string): Promise<void>;
  renew(ref: SessionRef, lease: string, leaseMs?: number): Promise<boolean>;
  clear(ref: SessionRef, part?: 'all' | 'history' | 'context'): Promise<string>;
  delete(ref: SessionRef): Promise<string>;
  purgeExpired?(): Promise<number>;
}

export declare class MemorySessionStore implements SessionStore {
  constructor(options?: { maxSessions?: number; maxSessionsPerPrincipal?: number });
  create(ref: Omit<SessionRef, 'id'>, state?: SessionState, ttlMs?: number): Promise<string>;
  acquire(ref: SessionRef, leaseMs?: number, ttlMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
  commit(ref: SessionRef, lease: string, state: SessionState, ttlMs?: number): Promise<boolean>;
  release(ref: SessionRef, lease: string): Promise<void>;
  renew(ref: SessionRef, lease: string, leaseMs?: number): Promise<boolean>;
  clear(ref: SessionRef, part?: 'all' | 'history' | 'context'): Promise<string>;
  delete(ref: SessionRef): Promise<string>;
}

export declare class PostgresSessionStore implements SessionStore {
  constructor(pool: { query(sql: string, values?: unknown[]): Promise<any>; connect(): Promise<any> }, options?: { maxSessionsPerPrincipal?: number });
  create(ref: Omit<SessionRef, 'id'>, state?: SessionState, ttlMs?: number): Promise<string>;
  acquire(ref: SessionRef, leaseMs?: number, ttlMs?: number): Promise<{ status: string; lease?: string; state?: SessionState }>;
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
  /** Optional Space-scoped key for polling desired pause/stop state. Separate from telemetry. */
  runtimeKey?: string;
  /** HTTPS NullProtocol API origin; loopback HTTP is allowed for local tests. */
  runtimeEndpoint?: string;
  /** Poll once per process, not per agent. Defaults to 15 seconds. */
  runtimePollMs?: number;
  authenticate?: (request: import('http').IncomingMessage) => Promise<{ principal: string; agents?: string[]; canManage?: boolean } | null>;
  store?: SessionStore;
  only?: string[];
  port?: number;
  host?: string;
  maxConcurrentTurns?: number;
  maxBodyBytes?: number;
  maxConnections?: number;
  handleSignals?: boolean;
}

export interface AgentServer extends Server {
  agents: Map<string, { def: AgentDefinition; base: AIToolkit; disabled: boolean; controlPaused: boolean; controlBlocked: boolean; controlRevision: number; controlStopEpoch: number; active: number }>;
  syncControl(): Promise<boolean>;
  shutdown(options?: { drainTimeoutMs?: number; cancelTimeoutMs?: number }): Promise<void>;
}

export function defineAgent(options: AgentDefinition): AgentDefinition;
export function serveAgents(options: AgentServerOptions): AgentServer;
export function serve(options: AgentServerOptions): AgentServer;

/** Connected Space client under development; the legacy NullProtocol constructor is unchanged in 2.x. */
export interface ManagedRun {
  id: string;
  agentId: string;
  conversationId: string | null;
  conversation: string | null;
  templateVersion: number;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  errorCode: string | null;
  output: { text: string } | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string;
}

export interface ManagedRunOptions {
  conversation?: string;
  context?: Record<string, unknown>;
  subject?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  wait?: boolean;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

export interface ManagedSpaceUsage {
  plan: string;
  day: string;
  limits: { activeRuns: number; runsPerDay: number; conversations: number; storageBytes: number; templates: number; managedAgents: number };
  usage: { activeRuns: number; runsToday: number; conversations: number; storageBytes: number; templates: number; managedAgents: number };
  tokens: { today: { input: number; output: number; runsWithoutUsage: number } };
}

export declare class NullProtocolClient {
  constructor(options: { spaceKey: string; endpoint?: string; fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<any>; timeoutMs?: number });
  space(options?: { signal?: AbortSignal }): Promise<{ id: string; slug: string; name: string }>;
  usage(options?: { signal?: AbortSignal }): Promise<ManagedSpaceUsage>;
  templates: {
    create(body: { name: string; config: Record<string, unknown> }, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<{ template: Record<string, unknown>; version: Record<string, unknown> }>;
    list(query?: { limit?: number; cursor?: string; archived?: boolean | 'all' }, options?: { signal?: AbortSignal }): Promise<{ templates: Record<string, unknown>[]; nextCursor: string | null }>;
    get(id: string, options?: { signal?: AbortSignal }): Promise<{ template: Record<string, unknown>; version: Record<string, unknown> }>;
    update(id: string, body: { name?: string; archived?: boolean }, options?: { signal?: AbortSignal }): Promise<{ template: Record<string, unknown> }>;
    publishVersion(id: string, body: { config: Record<string, unknown>; ifVersion: number }, options?: { signal?: AbortSignal }): Promise<{ template: Record<string, unknown>; version: Record<string, unknown> }>;
    listVersions(id: string, query?: { limit?: number; cursor?: string }, options?: { signal?: AbortSignal }): Promise<{ versions: Record<string, unknown>[]; nextCursor: string | null }>;
    getVersion(id: string, version: number, options?: { signal?: AbortSignal }): Promise<{ version: Record<string, unknown> }>;
    delete(id: string, options?: { signal?: AbortSignal }): Promise<{ deleted: boolean }>;
  };
  agents: {
    create(body: { templateId: string; version?: number; name?: string }, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    list(query?: { limit?: number; cursor?: string; templateId?: string }, options?: { signal?: AbortSignal }): Promise<{ agents: Record<string, unknown>[]; nextCursor: string | null }>;
    get(id: string, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    update(id: string, body: { ifRevision: number; name?: string; pinnedVersion?: number; state?: 'active' | 'paused'; avatarId?: string | null }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    setAction(id: string, name: string, body: { disabled: boolean; ifRevision: number }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    stop(id: string, body: { ifRevision: number }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown>; cancelled: number; cancelRequested: number }>;
    delete(id: string, options?: { signal?: AbortSignal }): Promise<{ deletion: { agentId: string; status: 'completed' | 'pending' } }>;
    run(id: string, input: unknown, options?: ManagedRunOptions): Promise<ManagedRun>;
  };
  agent(id: string): {
    context: {
      list(options?: { signal?: AbortSignal }): Promise<{ entries: Array<Record<string, unknown>> }>;
      get(key: string, options?: { signal?: AbortSignal }): Promise<{ entry: Record<string, unknown> }>;
      put(key: string, body: { value: unknown; ifVersion: string | null; ttlSeconds?: number | null }, options?: { signal?: AbortSignal }): Promise<{ entry: Record<string, unknown> }>;
      delete(key: string, body: { ifVersion: string }, options?: { signal?: AbortSignal }): Promise<{ deleted: boolean }>;
    };
    memory: {
      add(body: { text: string; source?: string }, options?: { signal?: AbortSignal }): Promise<{ entry: Record<string, unknown> }>;
      list(options?: { signal?: AbortSignal }): Promise<{ entries: Array<Record<string, unknown>> }>;
      delete(entryId: string, options?: { signal?: AbortSignal }): Promise<{ deleted: boolean }>;
    };
    conversations: {
      list(query?: { cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<{ conversations: Array<Record<string, unknown>>; nextCursor: string | null }>;
      get(key: string, query?: { afterSeq?: number; limit?: number }, options?: { signal?: AbortSignal }): Promise<{ conversation: Record<string, unknown>; messages: Array<Record<string, unknown>>; facts: Array<Record<string, unknown>>; summary: Record<string, unknown> | null; nextAfterSeq: number | null }>;
      delete(key: string, options?: { signal?: AbortSignal }): Promise<{ deletion: { conversationId: string; status: 'completed' | 'pending' } }>;
      deleteMessage(key: string, seq: number, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
      deleteFact(key: string, factId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
    };
    get(options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    update(body: { ifRevision: number; name?: string; pinnedVersion?: number; state?: 'active' | 'paused'; avatarId?: string | null }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    setAction(name: string, body: { disabled: boolean; ifRevision: number }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown> }>;
    stop(body: { ifRevision: number }, options?: { signal?: AbortSignal }): Promise<{ agent: Record<string, unknown>; cancelled: number; cancelRequested: number }>;
    delete(options?: { signal?: AbortSignal }): Promise<{ deletion: { agentId: string; status: 'completed' | 'pending' } }>;
    startRun(input: unknown, options?: ManagedRunOptions): Promise<ManagedRun>;
    getRun(runId: string, options?: { signal?: AbortSignal }): Promise<ManagedRun>;
    listRuns(query?: { limit?: number; cursor?: string }, options?: { signal?: AbortSignal }): Promise<{ runs: ManagedRun[]; nextCursor: string | null }>;
    listSteps(runId: string, options?: { signal?: AbortSignal }): Promise<{ steps: Record<string, unknown>[] }>;
    reconcileStep(runId: string, ordinal: number, body: { outcome: 'succeeded' | 'failed'; note?: string }, options?: { signal?: AbortSignal }): Promise<{ step: Record<string, unknown> }>;
    cancelRun(runId: string, options?: { signal?: AbortSignal }): Promise<ManagedRun>;
    run(input: unknown, options?: ManagedRunOptions): Promise<ManagedRun>;
    /**
     * What online executors registered for this Agent's pinned version: at
     * least one online, what the closest one lacks, and whether one declares
     * every action and the model credential ref. Declared compatibility only;
     * it does not check the model endpoint or its key.
     */
    runtime(options?: { signal?: AbortSignal }): Promise<{
      runtime: { online: boolean; lastSeenAt: string | null; missingActions: string[]; modelCompatible: boolean };
    }>;
  };
}

export declare class PlatformError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: { latestVersion?: number; revision?: number; limit?: number; runId?: string; unknownAgents?: string[] };
  readonly retryAfter: number | null;
}

export interface ManagedActionDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  effect: 'read' | 'write';
  timeoutMs?: number;
  /** Maximum serialized result size in bytes, up to 65536. Defaults to 8192. */
  maxResultBytes?: number;
  handler: (args: Record<string, unknown>, context: ManagedActionContext) => unknown | Promise<unknown>;
  guard?: (args: Record<string, unknown>, context: ManagedActionContext) => boolean | Promise<boolean>;
}

export declare function defineAction(definition: ManagedActionDefinition): ManagedActionDefinition;

export interface ManagedActionContext {
  runId: string;
  agentId: string;
  conversation: string | null;
  subject: Record<string, string> | null;
  runContext: Record<string, unknown> | null;
  spaceContext: Array<{ namespace: string; key: string; value: unknown; version: string }>;
  agentContext: Array<{ key: string; value: unknown; version: string }>;
  agentMemory: Array<{ id: string; text: string }>;
  pendingOutcomes: Array<Record<string, unknown>>;
  callId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

/** Connected outbound executor. One process can serve many managed Agents. */
export declare class ManagedExecutor {
  constructor(options: {
    executorKey: string;
    endpoint?: string;
    agentIds: string[];
    credentials: Record<string, { provider: string; baseURL: string; apiKey?: string; allowInsecureHttp?: boolean; toolCalls?: boolean }>;
    actions?: ManagedActionDefinition[];
    instanceId?: string;
    fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<any>;
    modelFetchImpl?: (input: string, init: Record<string, unknown>) => Promise<any>;
    onError?: (code: string) => void;
  });
  register(): Promise<{ instanceId: string; heartbeatSeconds: number; offlineAfterSeconds: number }>;
  pollOnce(waitSeconds?: number): Promise<unknown>;
  start(): Promise<this>;
  stop(): Promise<void>;
  /**
   * Null until start() succeeds. Resolves once polling has ended: `stopped`
   * after stop(), `agent_removed` when every Agent was deleted, the API error
   * code after rejected credentials or manifest, or `platform_unavailable`
   * when the API stopped serving this Space. Transient failures do not close it.
   */
  readonly closed: Promise<{ reason: string }> | null;
}

export default AIToolkit;
