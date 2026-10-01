// TypeScript definitions for nullprotocol/openai. openai.d.mts is the same file for
// ES module projects, so `OpenAI` resolves to the same declaration as theirs.
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
  /** Params whose stream flag is only known at run time. */
  create(
    params: OpenAI.ChatCompletionCreateParams,
    options?: OpenAI.RequestOptions
  ): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>>;
  /**
   * Cancels waiting and running calls and unread streams, records how each ended,
   * releases runtime control and sends buffered events.
   */
  close(): Promise<void>;
}

export function connectOpenAI(client: OpenAI, options: ConnectOpenAIOptions): ConnectedOpenAI;
