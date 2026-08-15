/**
 * Minimal provider connectivity check (Grace Free cost protection milestone).
 *
 * Sends ONE tiny request (max 64 output tokens, temperature 0) to each
 * configured server-side provider and reports ok/failed per provider.
 * (64 tokens: small enough to be free/negligible on every tier, but enough
 * for reasoning-capable models to emit actual content past their preamble.)
 *
 * SAFETY:
 *   - Never prints API keys (only whether a key is configured).
 *   - Never prints raw provider error text (only the classified category).
 *   - Cost is negligible (8 output tokens × the cheapest price).
 *
 * Usage: node scripts/check-providers.ts
 * Exit code 0 when every configured provider answered, 1 otherwise.
 */
import { join } from 'node:path';
import dotenv from 'dotenv';
import { createProvider } from '../src/providers/registry.ts';
import type { ChatMessage } from '../src/providers/types.ts';

const ROOT = process.cwd();
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

const PROVIDERS = [
  { id: 'groq', env: 'GROQ_API_KEY' },
  { id: 'nvidia', env: 'NVIDIA_API_KEY' },
  { id: 'gemini', env: 'GEMINI_API_KEY' },
  { id: 'minimax', env: 'MINIMAX_API_KEY' },
] as const;

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: ok' }];

async function check(id: string, key: string): Promise<boolean> {
  try {
    const provider = createProvider(id, { apiKey: key });
    const result = await provider.chat(MESSAGES, { maxTokens: 64, temperature: 0 });
    return result.content !== null || result.toolCalls.length > 0;
  } catch (err) {
    const category = (err as { category?: string }).category ?? 'unknown';
    console.log(`  ${id.padEnd(8)} FAILED (${category})`);
    return false;
  }
}

async function main(): Promise<void> {
  const results: Array<{ id: string; ok: boolean }> = [];
  for (const { id, env } of PROVIDERS) {
    const key = process.env[env]?.trim();
    if (!key) {
      console.log(`  ${id.padEnd(8)} not configured (${env} unset)`);
      continue;
    }
    process.stdout.write(`  ${id.padEnd(8)} checking…`);
    const ok = await check(id, key);
    process.stdout.write('\r');
    console.log(`  ${id.padEnd(8)} ${ok ? 'OK' : 'FAILED'}`);
    results.push({ id, ok });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'All configured providers responded.' : `${failed.length} configured provider(s) failed.`}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
