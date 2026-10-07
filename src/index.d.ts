export type Provider = 'openai' | 'anthropic' | 'openai-compatible';

/** What a process needs to call one provider. Cloud keys default to OPENAI_API_KEY and ANTHROPIC_API_KEY. */
export interface Credentials {
  apiKey?: string;
  /** The address of an OpenAI-compatible server, such as http://localhost:11434/v1. */
  baseURL?: string;
}

/** How this object calls the model. */
export interface CallOptions {
  /** Credentials by provider, for the models this process may be asked to call. */
  credentials?: Partial<Record<Provider, Credentials>>;
  timeout?: number;
  retry?: { maxRetries?: number };
  circuitBreaker?: { threshold?: number; resetAfterMs?: number };
  temperature?: number;
  maxTokens?: number;
  /** Extra turns the model gets to fix an unusable reply. Default 1. */
  repairAttempts?: number;
  /** The largest request, in bytes, this object sends to a model. Default 131072. */
  maxPromptBytes?: number;
  /** A name for this process, such as backend or worker. It only filters history. */
  label?: string;
  /**
   * Binds the object to one conversation, such as a customer or a chat. Its
   * context and memory are then that conversation's own, on top of the Agent's.
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

export interface Note {
  id: string;
  text: string;
  conversation?: string | null;
}

interface Outcome {
  success: boolean;
  error?: string;
  errorCode?: string;
  attempts?: number;
  repaired?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  /** Set when the operation ran but could not be written to history. */
  historyError?: string;
}

export interface Extraction<T = unknown> extends Outcome {
  data?: T | null;
}
export interface Validation extends Outcome {
  score?: number;
  recommendation?: 'pass' | 'fail' | 'conditional';
  reasoning?: string;
}
export interface Summary extends Outcome {
  summary?: string;
  keyPoints?: string[];
}
export interface Decision extends Outcome {
  action?: string | null;
  parameters?: Record<string, unknown>;
  reasoning?: string;
  rejectedAction?: string;
}
export interface Execution {
  success: boolean;
  outcome: 'completed' | 'failed' | 'refused';
  action?: string;
  result?: unknown;
  error?: string;
  errorCode?: string;
  historyError?: string;
}

export interface OperationOptions {
  /** Context entries with inclusion `selected` to send with this operation. */
  contextKeys?: string[];
}

export type ActionChoice = string | { action: string; description?: string };

export interface ActionContext {
  decision: Decision;
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
  validate(
    criteria: unknown,
    subject: unknown,
    reference?: unknown,
    options?: OperationOptions
  ): Promise<Validation>;
  summarize(
    content: unknown,
    options?: OperationOptions & { maxLength?: number; focus?: string }
  ): Promise<Summary>;
  decide(
    context: unknown,
    actions: ActionChoice[],
    options?: OperationOptions & { guard?: (decision: Decision) => boolean | Promise<boolean> }
  ): Promise<Decision>;

  /** An action a decision may choose. `chat` is built in. */
  registerAction(
    name: string,
    handler: (parameters: any, context: ActionContext) => unknown,
    options?: {
      input?: object;
      guard?: (parameters: any, decision: Decision) => boolean | Promise<boolean>;
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

  /** The Agent's context, or its conversation's when the object is bound to one. */
  context: ContextStore;
  /** Context shared by every Agent of the Space. An Agent's entry replaces one under the same key. */
  space: ContextStore;
  memory: {
    list(): Promise<Note[]>;
    add(text: string): Promise<Note>;
    delete(id: string): Promise<unknown>;
  };
}

export class AgentError extends Error {
  code: string;
}

export const NullProtocol: {
  /** Creates an Agent: saved in the Space of `key`, or in this process without one. */
  create(options: CreateOptions): Promise<Agent>;
  /** Loads a saved Agent by its agentId. */
  load(options: LoadOptions): Promise<Agent>;
};
