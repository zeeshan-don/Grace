/**
 * Server-side provider layer (Milestone 10).
 *
 * The production provider API key (GROQ_API_KEY) lives here — on the server —
 * and is never sent to the CLI or the browser. Once authenticated (Milestone
 * 11) the CLI will talk to this layer instead of holding its own key in
 * production. It reuses the existing provider-agnostic `AIProvider`
 * abstraction untouched (src/providers).
 */
import { createProvider } from '../providers/registry.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult } from '../providers/types.ts';
import { logApiEvent } from './log.ts';

export interface ServerProvider {
  provider: AIProvider;
}

export interface ServerProviderError {
  error: string;
}

export type ServerProviderResult = ServerProvider | ServerProviderError;

/** Build a provider for the server using the server-side key. */
export function createServerProvider(model?: string): ServerProviderResult {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { error: 'Server-side GROQ_API_KEY is not configured.' };
  }
  try {
    return { provider: createProvider('groq', { apiKey, model }) };
  } catch {
    // Never surface constructor internals (could echo the key or SDK details).
    return { error: 'Could not initialize the AI provider.' };
  }
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatOk {
  ok: true;
  result: ChatResult;
}

export interface ChatFail {
  ok: false;
  status: number;
  error: string;
}

export type ChatOutcome = ChatOk | ChatFail;

/**
 * Proxy a chat completion through the server-side provider. The caller only
 * ever sees content, tool calls and usage — never the provider key, and never
 * raw provider error text (which could echo credentials).
 */
export async function runServerChat(req: ChatRequest): Promise<ChatOutcome> {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, status: 400, error: '"messages" must be a non-empty array.' };
  }
  const created = createServerProvider(req.model);
  if ('error' in created) {
    return { ok: false, status: 503, error: created.error };
  }
  const opts: ChatOptions = {};
  if (req.temperature !== undefined) opts.temperature = req.temperature;
  if (req.maxTokens !== undefined) opts.maxTokens = req.maxTokens;
  const startedAt = Date.now();
  try {
    const result = await created.provider.chat(req.messages, opts);
    return { ok: true, result };
  } catch (err) {
    // The detailed (sanitized) reason goes to the server log for ops; the
    // client gets a generic message so nothing sensitive ever leaves the API.
    logApiEvent({
      method: 'POST',
      path: '/api/provider',
      status: 502,
      latencyMs: Date.now() - startedAt,
      model: req.model,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, status: 502, error: 'The AI provider request failed.' };
  }
}
