import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '../providers/types.ts';
import { ensureDir } from '../config/config.ts';

export interface SessionStats {
  runs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionData {
  messages: ChatMessage[];
  toolHistory: string[];
  stats: SessionStats;
}

const EMPTY_STATS: SessionStats = { runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Persists the conversation and tool history for the current project under
 * `.myagent/session.json`. History is used to continue multi-turn tasks and
 * is wiped by `/clear`. Never contains secrets: tool outputs are redacted
 * before they are stored.
 */
export class Session {
  messages: ChatMessage[] = [];
  toolHistory: string[] = [];
  stats: SessionStats = { ...EMPTY_STATS };

  private readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, '.myagent', 'session.json');
    ensureDir(join(projectRoot, '.myagent'));
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SessionData>;
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.toolHistory = Array.isArray(data.toolHistory) ? data.toolHistory : [];
      this.stats = { ...EMPTY_STATS, ...(data.stats ?? {}) };
    } catch {
      this.messages = [];
      this.toolHistory = [];
      this.stats = { ...EMPTY_STATS };
    }
  }

  save(): void {
    try {
      writeFileSync(
        this.path,
        JSON.stringify({ messages: this.messages, toolHistory: this.toolHistory, stats: this.stats }, null, 2),
        'utf8',
      );
    } catch {
      // Persistence is best-effort — never break the CLI over it.
    }
  }

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
    this.save();
  }

  get messageCount(): number {
    return this.messages.length;
  }
}
