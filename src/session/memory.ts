import type { ChatMessage } from '../providers/types.ts';
import type { ConversationStore, SessionStats } from './session.ts';

const EMPTY_STATS: SessionStats = { runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };

/**
 * In-memory conversation store used by coordinator subagents.
 *
 * Deliberately never touches disk: a subagent run (scout, picker, reviewer,
 * test runner, …) must not pollute the user's real `.zeesh/session.json`
 * history. Only the main editor agent uses the persistent `Session`.
 */
export class MemorySession implements ConversationStore {
  messages: ChatMessage[] = [];
  toolHistory: string[] = [];
  stats: SessionStats = { ...EMPTY_STATS };

  pushMessage(msg: ChatMessage): void {
    this.messages.push(msg);
  }

  recordToolCall(description: string): void {
    this.toolHistory.push(description);
    this.stats.toolCalls += 1;
  }

  beginRun(): void {
    this.stats.runs += 1;
  }

  addUsage(inputTokens: number | undefined, outputTokens: number | undefined): void {
    if (inputTokens) this.stats.inputTokens += inputTokens;
    if (outputTokens) this.stats.outputTokens += outputTokens;
  }

  clear(): void {
    this.messages = [];
    this.toolHistory = [];
    this.stats = { ...EMPTY_STATS };
  }

  save(): void {
    /* no-op — subagent history is ephemeral by design */
  }

  get messageCount(): number {
    return this.messages.length;
  }
}
