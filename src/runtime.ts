import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearSession, loadSession, sessionExpired, type StoredSession } from './auth/session.ts';
import { groqApiKey, loadAppConfig, resolveModel } from './config/config.ts';
import { createProvider } from './providers/registry.ts';
import { RemoteProvider } from './providers/remote.ts';
import type { AIProvider } from './providers/types.ts';
import { detectProject, type ProjectInfo } from './project/detect.ts';
import { isGitRepo } from './git/git.ts';
import { Session } from './session/session.ts';
import { UndoStore } from './session/undo.ts';
import { createTools, type Tool } from './tools/registry.ts';

export interface RuntimeOptions {
  /** Auto-approve flagged commands (dangerous). */
  yes?: boolean;
  /** Model override from CLI flag. */
  model?: string;
  /** Permission prompt implementation (the REPL injects its own). */
  ask?: (command: string, reasons: string[]) => Promise<boolean>;
}

export interface Runtime {
  root: string;
  project: ProjectInfo;
  session: Session;
  undo: UndoStore;
  provider: AIProvider | null;
  providerError: string | null;
  tools: Tool[];
  yes: boolean;
  ask: (command: string, reasons: string[]) => Promise<boolean>;
  model: string;
}

/** Shown when neither a local key nor a login session is available. */
export const NO_PROVIDER_MESSAGE =
  'No AI provider configured — add GROQ_API_KEY to .env or run "grace login" to use the GRACE backend. Slash commands still work.';

export type ProviderResolution =
  | { provider: AIProvider; error: null }
  | { provider: null; error: string };

/**
 * Pick the AI provider for a run:
 *  1. a local GROQ_API_KEY wins (offline/self-hosted usage),
 *  2. otherwise a valid login session proxies model calls through the GRACE
 *     backend (`POST /api/provider`) so production keys stay server-side.
 */
export function resolveProvider(
  key: string | undefined,
  model: string,
  session: StoredSession | null,
): ProviderResolution {
  if (key) {
    try {
      return { provider: createProvider('groq', { apiKey: key, model }), error: null };
    } catch (err) {
      return { provider: null, error: (err as Error).message };
    }
  }
  if (session && !sessionExpired(session)) {
    return { provider: new RemoteProvider({ apiUrl: session.apiUrl, token: session.token, model }), error: null };
  }
  return { provider: null, error: NO_PROVIDER_MESSAGE };
}

export function createRuntime(root: string, opts: RuntimeOptions = {}): Runtime {
  const cfg = loadAppConfig();
  const model = resolveModel(opts.model, cfg);
  const project = detectProject(root);
  ensureStateDirIgnore(root);
  const session = new Session(root);
  const undo = new UndoStore(root);

  const key = groqApiKey();
  const stored = loadSession();
  if (stored && sessionExpired(stored)) {
    clearSession(); // don't keep stale credentials around
  }
  const { provider, error: providerError } = resolveProvider(key, model, stored);

  const ask = opts.ask ?? defaultAsk;
  const tools = createTools({ projectRoot: root, askPermission: ask, undo });

  return { root, project, session, undo, provider, providerError, tools, yes: opts.yes ?? false, ask, model };
}

/** Keep the agent's own state out of the user's git repo (best-effort). */
export function ensureStateDirIgnore(root: string): void {
  if (!isGitRepo(root)) return;
  const gi = join(root, '.gitignore');
  const entry = '.zeesh/';
  const legacyEntry = '.myagent/'; // still ignored for projects created before the rename
  try {
    if (existsSync(gi)) {
      const content = readFileSync(gi, 'utf8');
      if (!content.split(/\r?\n/).some((l) => l.trim() === entry)) {
        appendFileSync(gi, (content.endsWith('\n') ? '' : '\n') + entry + '\n');
      }
      if (!content.split(/\r?\n/).some((l) => l.trim() === legacyEntry)) {
        appendFileSync(gi, legacyEntry + '\n');
      }
    } else {
      writeFileSync(gi, entry + '\n' + legacyEntry + '\n', 'utf8');
    }
  } catch {
    // best-effort
  }
}

/** Fallback permission prompt (used in one-shot mode when stdin is a TTY). */
async function defaultAsk(command: string, reasons: string[]): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const { stdin, stdout } = await import('node:process');
  if (!stdin.isTTY || !stdout.isTTY) return false; // piped/CI → deny by default
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      `\nThe agent wants to run:\n\n  ${command}\n\nFlagged: ${reasons.join('; ')}\n\nAllow? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
