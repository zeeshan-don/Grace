import { GroqProvider } from './groq.ts';
import type { AIProvider } from './types.ts';

export interface ProviderFactoryOptions {
  apiKey: string;
  model?: string;
}

/**
 * Create an AI provider by id.
 *
 * Extension points (Milestone 9): implement `AIProvider` and register it here.
 * Planned ids: gemini, anthropic, openai, nvidia, ollama.
 */
export function createProvider(id: string, opts: ProviderFactoryOptions): AIProvider {
  switch (id) {
    case 'groq':
      return new GroqProvider({ apiKey: opts.apiKey, model: opts.model });
    default:
      throw new Error(
        `Unknown provider "${id}". Implemented: groq. (Extension points exist for gemini, anthropic, openai, nvidia, ollama — not yet wired.)`,
      );
  }
}

export const SUPPORTED_PROVIDERS = ['groq'] as const;
