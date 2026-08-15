/**
 * FallbackProvider — the "Model Router" for a chain of providers.
 *
 * Tries providers in order for each model request (e.g. NVIDIA → Groq) and
 * returns the first successful result. The switch happens strictly at the
 * model-request boundary: we only move to the next provider after the current
 * one *threw* — no partial response was consumed, so no tool could have
 * executed and a fresh request to another provider cannot duplicate work.
 * We never retry after a response has been received.
 *
 * All failure detail is kept sanitized (no API keys), and the aggregate error
 * names every provider that failed so the operator can see the chain state.
 */
import { ProviderError, scrub, describeCategory, isFallbackEligible, type ProviderErrorCategory } from './errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent } from './types.ts';

/** One entry of the last request's attempt log (sanitized, for status/logs). */
export interface FallbackAttempt {
  providerId: string;
  label: string;
  category: ProviderErrorCategory | 'ok';
  /** Sanitized failure detail (never contains a key). */
  message: string;
}

export class FallbackProvider implements AIProvider {
  readonly id = 'router';
  readonly label = 'GRACE model router';

  private readonly chain: AIProvider[];
  private servingProvider: AIProvider | null = null;
  private attemptLog: FallbackAttempt[] = [];

  constructor(chain: AIProvider[]) {
    if (chain.length < 2) {
      throw new Error('FallbackProvider requires at least two providers in the chain.');
    }
    this.chain = chain;
  }

  /** The provider that served the last successful request (null after a total failure). */
  get lastServed(): AIProvider | null {
    return this.servingProvider;
  }

  /** The first (primary) provider in the chain. */
  get primary(): AIProvider {
    return this.chain[0] as AIProvider;
  }

  /** Sanitized log of the last request's provider attempts (health/status). */
  get lastAttempts(): readonly FallbackAttempt[] {
    return this.attemptLog;
  }

  getModel(): ModelInfo {
    return (this.chain[0] as AIProvider).getModel();
  }

  setModel(modelId: string): void {
    for (const provider of this.chain) provider.setModel(modelId);
  }

  async listModels(): Promise<string[]> {
    for (const provider of this.chain) {
      const models = await provider.listModels();
      if (models.length > 0) return models;
    }
    return [];
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const attempts: FallbackAttempt[] = [];
    let lastError: ProviderError | null = null;

    for (const provider of this.chain) {
      try {
        const result = await provider.chat(messages, options);
        this.servingProvider = provider;
        attempts.push({ providerId: provider.id, label: provider.label, category: 'ok', message: '' });
        this.attemptLog = attempts;
        return result;
      } catch (err) {
        const providerError = ProviderError.wrap(provider.id, err);
        lastError = providerError;
        attempts.push({
          providerId: provider.id,
          label: provider.label,
          category: providerError.category,
          message: scrub(providerError.message),
        });
        // Fallback is safe here by construction: we never saw a response, so
        // nothing was executed — a request to the next provider cannot
        // duplicate tool work. Only provider-level failures activate the
        // router (see isFallbackEligible); task/model/tool errors never
        // surface as ProviderError from the provider boundary, so they can
        // never trigger a switch. The failure stays visible in `attemptLog`
        // and the aggregate error.
        if (!isFallbackEligible(providerError.category)) {
          this.servingProvider = null;
          this.attemptLog = attempts;
          throw providerError;
        }
      }
    }

    this.servingProvider = null;
    this.attemptLog = attempts;
    throw this.aggregate(attempts, lastError);
  }

  /** Buffered stream: fallback must never happen mid-stream, so we buffer via chat. */
  async *streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const result = await this.chat(messages, options);
    if (result.content) yield { type: 'content', content: result.content };
    for (const [index, tc] of result.toolCalls.entries()) {
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
    }
    yield { type: 'done', usage: result.usage };
  }

  private aggregate(attempts: FallbackAttempt[], lastError: ProviderError | null): ProviderError {
    const summary = attempts
      .map((a) => (a.category === 'ok' ? null : `${a.label} (${describeCategory(a.category)})`))
      .filter((s): s is string => s !== null)
      .join('; ');
    const detail = `All AI providers failed — ${summary}. Check the server-side provider configuration.`;
    return new ProviderError(this.id, lastError?.category ?? 'unknown', detail, lastError?.status ?? 502);
  }
}
