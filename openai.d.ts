// TypeScript definitions for nullprotocol/openai.
import type OpenAI from 'openai';

export interface ConnectOpenAIOptions {
  /** Stable ID of this agent in the cabinet, a lowercase slug. */
  agentId: string;
  /** Space ingest key from the cabinet. */
  telemetryKey: string;
  /** HTTPS origin of the NullProtocol API, such as https://api.nullprotocol.ai. */
  telemetryEndpoint: string;
  /** Runtime key for pause and stop from the cabinet; requires runtimeEndpoint. */
  runtimeKey?: string;
  /** Origin of the NullProtocol API for runtime control. */
  runtimeEndpoint?: string;
}

export interface ConnectedOpenAI {
  /**
   * The client's chat.completions.create, reported as one model.call event.
   * Resolves to the SDK's completion unchanged and rejects with the SDK's error.
   * A plain Promise: withResponse() and asResponse() are not available.
   * While the agent cannot run, rejects with ControlError without a request.
   */
  create(
    params: OpenAI.ChatCompletionCreateParamsNonStreaming,
    options?: OpenAI.RequestOptions
  ): Promise<OpenAI.ChatCompletion>;
  /**
   * A stream as an async iterable of the SDK's chunks. It is not the SDK's Stream:
   * there is no controller, tee() or toReadableStream(). Closing the iteration,
   * stop or close() closes the connection; a cancelled stream raises its reason.
   */
  create(
    params: OpenAI.ChatCompletionCreateParamsStreaming,
    options?: OpenAI.RequestOptions
  ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
  /** Cancels calls in flight and unread streams, releases runtime control and sends buffered events. */
  close(): Promise<void>;
}

export function connectOpenAI(client: OpenAI, options: ConnectOpenAIOptions): ConnectedOpenAI;
