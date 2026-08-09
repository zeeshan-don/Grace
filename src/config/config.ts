import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

/** Default model candidates tried in order when the configured model is unavailable. */
export const DEFAULT_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
  'llama-3.3-70b-versatile',
] as const;

export interface AppConfig {
  /** Provider id — only "groq" is implemented so far (extension point for more). */
  provider?: string;
  /** Selected model id. */
  model?: string;
}

const CONFIG_DIR = join(homedir(), '.zeesh');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * One-time migration from the legacy `~/.myagent/` directory (pre-rename).
 *
 * Copies the old directory's contents into `~/.zeesh/` when the new directory
 * does not exist yet. It is copy-only: the legacy directory is never deleted
 * automatically, so nothing is destroyed if a copy is partial or fails.
 * Idempotent and safe to run on every start.
 */
export function migrateLegacyConfig(): void {
  try {
    const legacy = join(homedir(), '.myagent');
    if (!existsSync(legacy) || existsSync(CONFIG_DIR)) return;
    if (readdirSync(legacy).length === 0) return; // nothing to migrate
    mkdirSync(CONFIG_DIR, { recursive: true });
    copyTree(legacy, CONFIG_DIR);
  } catch {
    // Best-effort — never break the CLI over a failed migration.
  }
}

function copyTree(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else if (entry.isFile()) {
      copyFileSync(src, dest);
      try {
        chmodSync(dest, statSync(src).mode & 0o777); // preserve 0600 on auth.json
      } catch {
        // best-effort
      }
    }
  }
}

/** Runs once per process before any config path is used. */
migrateLegacyConfig();

/**
 * Loads configuration into process.env (never exposes values to the model):
 *  1. `~/.zeesh/env` — the user's zeesh-level secrets
 *  2. `<project>/.env`  — the project's own environment
 * Process-level env vars always take precedence.
 */
export function loadEnv(projectRoot: string): void {
  dotenv.config({ path: join(CONFIG_DIR, 'env'), quiet: true });
  dotenv.config({ path: join(projectRoot, '.env'), quiet: true });
}

export function groqApiKey(): string | undefined {
  const key = process.env.GROQ_API_KEY?.trim();
  return key ? key : undefined;
}

/** Default ZEESH AI backend URL used by login/usage-reporting when unset. */
export const DEFAULT_API_URL = 'http://localhost:8787';

/** The ZEESH AI backend the CLI authenticates against (env override). */
export function zeeshApiUrl(): string {
  return process.env.ZEESH_API_URL?.trim() || DEFAULT_API_URL;
}

export function loadAppConfig(): AppConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

export function saveAppConfig(cfg: AppConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Resolve the effective model id: CLI flag > saved config > default. */
export function resolveModel(cliModel: string | undefined, cfg: AppConfig): string {
  if (cliModel) return cliModel;
  if (cfg.model) return cfg.model;
  return DEFAULT_MODELS[0] as string;
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
