import { DeepSeekProvider } from './deepseek.ts';
import { GroqProvider } from './groq.ts';
import { NvidiaProvider } from './nvidia.ts';
import type { AIProvider } from './types.ts';

export interface ProviderFactoryOptions {
  apiKey: string;
  model?: string;
}

/**
 * Create an AI provider by id.
 *
 * Extension points (Milestone 9): implement `AIProvider` and register it here.
 * Planned ids: gemini, anthropic, openai, ollama.
 */
export function createProvider(id: string, opts: ProviderFactoryOptions): AIProvider {
  switch (id) {
    case 'groq':
      return new GroqProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'nvidia':
      return new NvidiaProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'deepseek':
      return new DeepSeekProvider({ apiKey: opts.apiKey, model: opts.model });
    default:
      throw new Error(
        `Unknown provider "${id}". Implemented: groq, nvidia, deepseek. (Extension points exist for gemini, anthropic, openai, ollama — not yet wired.)`,
      );
  }
}

export const SUPPORTED_PROVIDERS = ['groq', 'nvidia', 'deepseek'] as const;
