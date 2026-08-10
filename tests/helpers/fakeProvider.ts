import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ModelInfo,
  StreamEvent,
} from '../../src/providers/types.ts';

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** When set, streamChat throws this error (provider failure). */
  error?: string;
  /** Artificial delay before responding (parallelism tests). */
  delayMs?: number;
}

/** Scripted provider: replays turns from a script, defaulting to 'Done.'. */
export class FakeProvider implements AIProvider {
  readonly id = 'fake';
  readonly label = 'Fake (test)';
  private readonly model: ModelInfo = { id: 'fake-1', contextWindow: 128_000, supportedFeatures: ['tool_calls', 'streaming'] };
  callCount = 0;
  private readonly script: ScriptedTurn[];

  constructor(script: ScriptedTurn[] = []) {
    this.script = script;
  }

  getModel(): ModelInfo {
    return this.model;
  }

  setModel(): void {
    /* no-op */
  }

  async listModels(): Promise<string[]> {
    return [this.model.id];
  }

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
    throw new Error('streamChat is used by the loop');
  }

  async *streamChat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<StreamEvent> {
    const turn = this.script[this.callCount] ?? { content: 'Done.' };
    this.callCount += 1;
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.error) throw new Error(turn.error);
    for (const tc of turn.toolCalls ?? []) {
      yield { type: 'tool_call_delta', index: 0, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
    }
    if (turn.content) yield { type: 'content', content: turn.content };
    yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  }
}
