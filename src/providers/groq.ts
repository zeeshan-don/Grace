import Groq from 'groq-sdk';
import { estimateTokens } from '../util/text.ts';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ModelInfo,
  StreamEvent,
  ToolCallParam,
  ToolDefinition,
  Usage,
} from './types.ts';

const DEFAULT_CONTEXT = 128_000;
const KNOWN_CONTEXTS: Record<string, number> = {
  'llama-3.1-8b-instant': 131_072,
  'llama-3.3-70b-versatile': 131_072,
  'openai/gpt-oss-120b': 131_072,
  'openai/gpt-oss-20b': 131_072,
  'qwen/qwen3.6-27b': 131_072,
};

interface GroqToolCallArgs {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Converts our messages to the OpenAI/Groq wire format. */
function toWire(messages: ChatMessage[]): Groq.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id ?? '',
        content: m.content ?? '',
      } satisfies Groq.Chat.Completions.ChatCompletionMessageParam;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } satisfies Groq.Chat.Completions.ChatCompletionMessageParam;
    }
    return { role: m.role, content: m.content ?? '' } as Groq.Chat.Completions.ChatCompletionMessageParam;
  });
}

function fromWireToolCalls(tcs: Groq.Chat.Completions.ChatCompletionMessageToolCall[]): ToolCallParam[] {
  return tcs.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '{}' }));
}

function toUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: u.total_tokens ?? inputTokens + outputTokens };
}

export class GroqProvider implements AIProvider {
  readonly id = 'groq';
  readonly label = 'Groq (LPU)';

  private readonly client: Groq;
  private modelId: string;
  private modelsCache: string[] | null = null;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Groq({ apiKey: opts.apiKey });
    this.modelId = opts.model ?? 'openai/gpt-oss-120b';
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: KNOWN_CONTEXTS[this.modelId] ?? DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'streaming', 'json'],
    };
  }

  setModel(modelId: string): void {
    this.modelId = modelId;
    this.modelsCache = null;
  }

  async listModels(): Promise<string[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      const list = await this.client.models.list();
      this.modelsCache = list.data.map((m) => m.id).sort();
      return this.modelsCache;
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const tools = options.tools?.map((t) => t as Groq.Chat.Completions.ChatCompletionTool);
    const res = await this.client.chat.completions.create(
      {
        model: this.modelId,
        messages: toWire(messages),
        tools,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
      },
      { signal: options.signal },
    );
    const msg = res.choices[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: msg?.tool_calls ? fromWireToolCalls(msg.tool_calls) : [],
      usage: toUsage(res.usage),
      finishReason: res.choices[0]?.finish_reason ?? 'stop',
    };
  }

  async *streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const tools = options.tools?.map((t) => t as Groq.Chat.Completions.ChatCompletionTool);
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelId,
        messages: toWire(messages),
        tools,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
      },
      { signal: options.signal },
    );

    // Groq reports usage via x_groq on the final chunk; we estimate instead.
    let outputChars = 0;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        outputChars += delta.content.length;
        yield { type: 'content', content: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls as GroqToolCallArgs[]) {
          yield {
            type: 'tool_call_delta',
            index: tc.index ?? 0,
            id: tc.id,
            name: tc.function?.name,
            argumentsDelta: tc.function?.arguments,
          };
        }
      }
    }

    const input = estimateTokens(JSON.stringify(messages));
    const output = Math.max(1, Math.ceil(outputChars / 4));
    yield { type: 'done', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output } };
  }
}
