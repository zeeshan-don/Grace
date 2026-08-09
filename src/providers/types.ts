/**
 * Provider-agnostic AI interfaces (Milestone 2 / 9).
 *
 * The rest of the application only ever talks to `AIProvider`. Groq is the
 * first implementation; Gemini, Anthropic, OpenAI, NVIDIA and local models
 * (Ollama) are future implementations of the same contract.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallParam {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Set for tool result messages — id of the tool call being answered. */
  tool_call_id?: string;
  /** Set for assistant messages that requested tool calls. */
  tool_calls?: ToolCallParam[];
  /** Optional name for tool messages. */
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelInfo {
  id: string;
  /** Approximate context window in tokens. */
  contextWindow: number;
  supportedFeatures: string[];
}

export interface ChatOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Abort signal forwarded to the underlying SDK. */
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCallParam[];
  usage?: Usage;
  finishReason: string;
}

export type StreamEvent =
  | { type: 'content'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'done'; usage?: Usage };

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  /** Currently selected model. */
  getModel(): ModelInfo;
  /** Switch the active model. */
  setModel(modelId: string): void;
  /** List model ids available on the provider (may require credentials). */
  listModels(): Promise<string[]>;
  /** Non-streaming completion (used by tests and fallbacks). */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  /** Streaming completion: content deltas + tool call deltas + done. */
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamEvent>;
}
