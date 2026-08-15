import { DeepSeekProvider } from './deepseek.ts';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';
import { MiniMaxProvider } from './minimax.ts';
import { NvidiaProvider } from './nvidia.ts';
import type { AIProvider } from './types.ts';

export interface ProviderFactoryOptions {
  apiKey: string;
  model?: string;
}

/**
 * Create an AI provider by id.
 *
 * Implemented: groq, nvidia, deepseek, gemini, minimax (all real providers —
 * see each file for its API). Extension points remain for anthropic, openai,
 * ollama.
 */
export function createProvider(id: string, opts: ProviderFactoryOptions): AIProvider {
  switch (id) {
    case 'groq':
      return new GroqProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'nvidia':
      return new NvidiaProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'deepseek':
      return new DeepSeekProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'gemini':
      return new GeminiProvider({ apiKey: opts.apiKey, model: opts.model });
    case 'minimax':
      return new MiniMaxProvider({ apiKey: opts.apiKey, model: opts.model });
    default:
      throw new Error(
        `Unknown provider "${id}". Implemented: groq, nvidia, deepseek, gemini, minimax. (Extension points exist for anthropic, openai, ollama — not yet wired.)`,
      );
  }
}

export const SUPPORTED_PROVIDERS = ['groq', 'nvidia', 'deepseek', 'gemini', 'minimax'] as const;
