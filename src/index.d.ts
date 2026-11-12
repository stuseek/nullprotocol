export type Provider = 'nullprotocol' | 'openai' | 'anthropic' | 'ollama' | 'openai-compatible';

/** What a process needs to call one provider. Cloud keys default to OPENAI_API_KEY and ANTHROPIC_API_KEY. */
export interface Credentials {
  apiKey?: string;
  /** The address of an OpenAI-compatible server, such as http://localhost:8000/v1, or of Ollama. */
  baseURL?: string;
}

/** How this object calls the model. */
export interface CallOptions {
  /** Credentials by provider, for the models this process may be asked to call. */
  credentials?: Partial<Record<Provider, Credentials>>;
  /** Milliseconds per request attempt. Default 30000. */
  timeout?: number;
  retry?: { maxRetries?: number };
  circuitBreaker?: { threshold?: number; resetAfterMs?: number };
  temperature?: number;
  /** Maximum generated tokens. Default 1000. */
  maxTokens?: number;
  /**
   * How many characters of a saved Agent's documents an operation can take,
   * counted as a string's length. 6000 when left out. Documents are given
   * whole: when they are more, the operation fails with documents_too_large.
   */
  documentBudget?: number;
  /** Extra turns the model gets to fix an unusable reply. Default 1. */
  repairAttempts?: number;
  /** The largest request, in bytes, this object sends to a model. Default 131072. */
  maxPromptBytes?: number;
  /** A name for this process, such as backend or worker. It only filters history. */
  label?: string;
  /**
   * Selects saved data for any entity or unit of work: an order, project, job,
   * user or session. IDs are flat, not nested. Agent-wide notes are included
   * in every scope; Knowledge connections stay agent-wide. No dialogue is
   * saved automatically. Hosted IDs: 1–128 characters, no control characters.
   */
  conversation?: string;
}

export interface CreateOptions extends CallOptions, Credentials {
  /** The SDK key of a Space. With it the Agent is saved there; without it the Agent lives in this process. */
  key?: string;
  endpoint?: string;
  /** Issued when left out. */
  agentId?: string;
  name?: string;
  provider: Provider;
  model: string;
  /** Who the Agent is, what it is for and the rules it follows. */
  instructions?: string;
}

export interface LoadOptions extends CallOptions {
  key: string;
  endpoint?: string;
  agentId: string;
}

export interface Settings {
  provider: Provider;
  model: string;
  instructions: string;
  paused?: boolean;
  /** Actions the Agent may not choose or run. */
  disabledActions?: string[];
  name?: string;
  revision?: number;
}

export interface ContextEntry {
  key: string;
  value: unknown;
  /** `always` is sent with every operation, `selected` only with those that name its key. */
  inclusion: 'always' | 'selected';
  version: string;
  conversation?: string | null;
  scope?: 'space' | 'agent' | 'conversation';
}

export interface ContextStore {
  list(): Promise<ContextEntry[]>;
  get(key: string): Promise<ContextEntry>;
  set(
    key: string,
    value: unknown,
    options?: { inclusion?: 'always' | 'selected'; ifVersion?: string | null }
  ): Promise<ContextEntry>;
  delete(key: string): Promise<unknown>;
}

export interface KnowledgeRevision {
  id: string;
  revision: number;
  version: string;
}

export interface KnowledgeSource extends KnowledgeRevision {
  name: string;
  scope: 'space' | 'agent';
  activeRevision: number | null;
  characters: number;
  hash: string;
  state: 'preparing' | 'ready' | 'failed';
  error: string | null;
  retryScheduled: boolean;
  updatedAt: string;
  attached: boolean;
}

export interface KnowledgeDocuments {
  /** Documents owned by this scope; connected Space sources are listed separately. */
  list(): Promise<KnowledgeSource[]>;
  get(id: string): Promise<KnowledgeSource & { text: string }>;
  /** Waits for this exact version using metadata reads. Timeout is milliseconds. */
  waitUntilReady(source: KnowledgeRevision, options?: { timeout?: number; signal?: AbortSignal }): Promise<KnowledgeSource>;
  /** Returns before asynchronous preparation finishes. Use waitUntilReady to await it. */
  add(input: { name: string; text: string }): Promise<KnowledgeRevision>;
  update(id: string, input: { name?: string; text?: string; ifVersion: string }): Promise<KnowledgeRevision>;
  delete(id: string, options: { ifVersion: string }): Promise<{ deleted: boolean }>;
  retry(id: string): Promise<{ retrying: boolean }>;
}

export interface AgentKnowledge extends KnowledgeDocuments {
  connections(): Promise<KnowledgeSource[]>;
  connect(spaceSourceId: string): Promise<{ attached: boolean }>;
  disconnect(spaceSourceId: string): Promise<{ attached: boolean }>;
}

export interface KnowledgeLibrary extends KnowledgeDocuments {
  /** Space embedding usage for the last 30 days; token sums are decimal strings or unknown. */
  usage(): Promise<{ preparation: string | null; search: string | null; uncounted: number; requests: number }>;
}

export interface SpaceContextStore extends ContextStore {
  knowledge: KnowledgeLibrary;
}

export interface Note {
  id: string;
  text: string;
  conversation?: string | null;
}

/** Provider-reported usage, including partial totals when some requests were not counted. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  uncountedRequests?: number;
}

/** What a saved task holds besides its operation's own settings. */
interface TaskOptions {
  /** Context entries with inclusion `selected` to send with every run. */
  contextKeys?: string[];
  /** Search the Agent's Knowledge with the input of every run. */
  knowledge?: boolean;
}

/** One operation with the settings its caller would otherwise send each time. */
export type TaskSettings = TaskOptions &
  (
    | { operation: 'extract'; schema: object }
    | { operation: 'summarize'; maxLength?: number; focus?: string }
    | { operation: 'validate'; criteria: string }
    | { operation: 'decide'; actions: Exclude<ActionChoice, string>[] }
  );

export type Task = TaskSettings & { name: string; revision: number; updatedAt?: string };

export interface TaskStore {
  list(): Promise<Task[]>;
  get(name: string): Promise<Task>;
  /** `ifRevision: null` only creates; a number replaces that revision; left out, it overwrites. */
  set(name: string, task: TaskSettings & { ifRevision?: number | null }): Promise<Task>;
  delete(name: string): Promise<unknown>;
}

/** What every result carries, whether the operation succeeded or not. */
interface Ran {
  /** The saved task the operation ran as, its revision then and its operation. */
  task?: { name: string; revision: number; operation: 'extract' | 'summarize' | 'validate' | 'decide' };
  /** The selected Knowledge evidence and actual search query, when requested. */
  knowledge?: KnowledgeEvidence;
  /** Search embedding usage, separately from generation, including failed searches. */
  knowledgeUsage?: { inputTokens?: number; uncountedRequests?: number };
  attempts?: number;
  repaired?: boolean;
  /**
   * The tokens the provider reported, cached input included, on a failed
   * operation too. `uncountedRequests` is how many requests it did not count,
   * such as one that failed or timed out. The whole `usage` field is absent when no request had reported usage.
   */
  usage?: Usage;
  /** Set when the operation ran but could not be written to history. */
  historyError?: string;
}

/** A failed operation: `error` says what happened and `errorCode` names it. */
export interface Failure extends Ran {
  success: false;
  error: string;
  errorCode: string;
}

export type Result<T> = (Ran & { success: true } & T) | Failure;

export type Extraction<T = unknown> = Result<{ data: T }>;
export type Validation = Result<{
  score: number;
  recommendation: 'pass' | 'fail' | 'conditional';
  reasoning: string;
}>;
export type Summary = Result<{ summary: string; keyPoints: string[] }>;
/** A decision the guard rejected is a failure that names the action in `rejectedAction`. */
export type Decision =
  | Result<{ action: string; parameters: Record<string, unknown>; reasoning: string }>
  | (Failure & { rejectedAction?: string });

export type Execution =
  | { success: true; outcome: 'completed'; action: string; result: unknown; historyError?: string }
  | {
      success: false;
      outcome: 'failed' | 'refused';
      action?: string;
      error: string;
      errorCode: string;
      historyError?: string;
    };

export interface OperationOptions {
  /** Up to four reachable HTTPS photo URLs. Requires a Vision-capable model. */
  images?: string[];
  /** Search only this agent's own and explicitly connected Space sources. Omitted means no search. */
  knowledge?: boolean | { query: string };
  /** Context entries with inclusion `selected` to send with this operation. */
  contextKeys?: string[];
}

export interface KnowledgeEvidence {
  id: string;
  query: string;
  profile: string;
  sources: {
    sourceId: string;
    name: string;
    revision: number;
    passages: { start: number; end: number; heading: string; text: string }[];
  }[];
}

export type ActionChoice = string | { action: string; description?: string; parameters?: object };

/** A successful decision. */
export type Chosen = Extract<Decision, { success: true }>;

export interface ActionContext {
  decision: Chosen;
  /** What the decision was made about. */
  input: unknown;
  /** Asks the model for a plain-text answer, as the decision's own model and instructions. */
  reply(message: string): Promise<string>;
}

export interface Agent {
  readonly agentId: string;
  readonly instanceId: string;
  readonly label?: string;
  readonly conversation?: string;

  extract<T = unknown>(
    data: unknown,
    schema: object,
    options?: OperationOptions
  ): Promise<Extraction<T>>;
  /** Judges `subject` against `criteria`; `reference` is what to compare it with, if anything. */
  validate(
    criteria: unknown,
    subject: unknown,
    options?: OperationOptions & { reference?: unknown }
  ): Promise<Validation>;
  summarize(
    content: unknown,
    options?: OperationOptions & { maxLength?: number; focus?: string }
  ): Promise<Summary>;
  decide(
    context: unknown,
    actions: ActionChoice[],
    options?: OperationOptions & { guard?: (decision: Chosen) => boolean | Promise<boolean> }
  ): Promise<Decision>;

  /**
   * Runs a saved task on `input`. The operation and its schema, criteria or
   * actions come from the task, so changing the task changes the next run.
   * Name the result the task's operation returns: `run<Extraction<Order>>(…)`.
   */
  run<R extends Extraction | Summary | Validation | Decision = Extraction>(
    task: string,
    input: unknown,
    options?: OperationOptions & { reference?: unknown }
  ): Promise<R>;
  /** Operations saved with their settings, run by name with `run`. */
  tasks: TaskStore;

  /** Registers an application action, its parameter schema and optional execution guard. */
  registerAction(
    name: string,
    handler: (parameters: any, context: ActionContext) => unknown,
    options?: {
      description?: string;
      input?: object;
      guard?: (parameters: any, decision: Chosen) => boolean | Promise<boolean>;
    }
  ): this;
  /** Runs the handler of a decision this object made, once. */
  execute(decision: Decision): Promise<Execution>;

  settings(): Promise<Settings>;
  update(
    changes: Partial<
      Pick<Settings, 'provider' | 'model' | 'instructions' | 'name' | 'paused' | 'disabledActions'>
    >
  ): Promise<Settings>;

  /** The Agent's context, or the selected data scope's context when `conversation` is set. */
  context: ContextStore;
  /** Context shared by every Agent of the Space. An Agent's entry replaces one under the same key. */
  space: SpaceContextStore;
  /** Agent-owned documents and explicit connections to Space sources. */
  knowledge: AgentKnowledge;
  /** Explicit saved facts: agent-wide without `conversation`, otherwise scoped to that ID. */
  memory: {
    list(): Promise<Note[]>;
    add(text: string): Promise<Note>;
    delete(id: string): Promise<unknown>;
  };
}

export class AgentError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string;
}

export const NullProtocol: {
  /** Creates an Agent: saved in the Space of `key`, or in this process without one. */
  create(options: CreateOptions): Promise<Agent>;
  /** Loads a saved Agent by its agentId. */
  load(options: LoadOptions): Promise<Agent>;
};
