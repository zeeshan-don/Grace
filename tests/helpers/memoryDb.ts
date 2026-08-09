/**
 * In-memory Db for integration tests.
 *
 * Implements the exact query strings used by AuthService (src/api/authService.ts)
 * and UsageService (src/api/usage.ts) so endpoint tests exercise the full
 * request → handler → service → SQL path without a real database.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/api/db.ts';

export interface MemUser {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  is_beta?: boolean;
}

export interface MemSession {
  user_id: string;
  token_hash: string;
  device: string;
  expires_at: string;
}

export interface MemRun {
  id: number;
  client_run_id: string | null;
  user_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface MemUsageRow {
  id: number;
  user_id: string;
  run_id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export interface MemoryDb {
  db: Db;
  users: MemUser[];
  sessions: MemSession[];
  runs: MemRun[];
  usageRows: MemUsageRow[];
}

/** Create a fresh in-memory database. */
export function createMemoryDb(): MemoryDb {
  let nextId = 1;
  const users: MemUser[] = [];
  const sessions: MemSession[] = [];
  const runs: MemRun[] = [];
  const usageRows: MemUsageRow[] = [];

  const db: Db = async (sql, params: unknown[] = []) => {
    // Health probe.
    if (sql.includes('SELECT 1')) return [];

    // ---- AuthService ------------------------------------------------------
    if (sql.includes('INSERT INTO users')) {
      const [email, displayName, passwordHash, isBeta] = params as [string, string | null, string, boolean | undefined];
      users.push({
        id: randomUUID(),
        email,
        display_name: displayName,
        password_hash: passwordHash,
        is_beta: isBeta ?? false,
      });
      return [{ id: users[users.length - 1]?.id }];
    }
    if (sql.includes('FROM users') && sql.includes('password_hash')) {
      const email = params[0] as string;
      const u = users.find((x) => x.email === email);
      return u ? [{ id: u.id, email: u.email, display_name: u.display_name, password_hash: u.password_hash }] : [];
    }
    if (sql.includes('SELECT id FROM users')) {
      const email = params[0] as string;
      const u = users.find((x) => x.email === email);
      return u ? [{ id: u.id }] : [];
    }
    if (sql.includes('INSERT INTO sessions')) {
      const [userId, tokenHash, device, expiresAt] = params as [string, string, string, string];
      sessions.push({ user_id: userId, token_hash: tokenHash, device, expires_at: expiresAt });
      return [{ id: nextId++ }];
    }
    if (sql.includes('DELETE FROM sessions')) {
      const tokenHash = params[0] as string;
      const i = sessions.findIndex((s) => s.token_hash === tokenHash);
      if (i >= 0) sessions.splice(i, 1);
      return [];
    }
    if (sql.includes('JOIN users')) {
      const tokenHash = params[0] as string;
      const s = sessions.find((x) => x.token_hash === tokenHash);
      if (!s) return [];
      const u = users.find((x) => x.id === s.user_id);
      if (!u) return [];
      return [{ id: u.id, email: u.email, display_name: u.display_name, expires_at: s.expires_at }];
    }

    // ---- UsageService -----------------------------------------------------
    if (sql.includes('INSERT INTO agent_runs')) {
      const clientRunId = params[0] as string | null;
      if (clientRunId && runs.some((r) => r.client_run_id === clientRunId)) return []; // ON CONFLICT DO NOTHING
      const run: MemRun = {
        id: nextId++,
        client_run_id: clientRunId,
        user_id: params[1] as string,
        model: params[6] as string,
        input_tokens: params[9] as number,
        output_tokens: params[10] as number,
      };
      runs.push(run);
      return [{ id: run.id }];
    }
    if (sql.includes('SELECT id FROM agent_runs')) {
      const clientRunId = params[0] as string;
      const r = runs.find((x) => x.client_run_id === clientRunId);
      return r ? [{ id: r.id }] : [];
    }
    if (sql.includes('INSERT INTO usage')) {
      const [userId, runId, model, inputTokens, outputTokens] = params as [string, number, string, number, number];
      usageRows.push({
        id: nextId++,
        user_id: userId,
        run_id: runId,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        created_at: new Date().toISOString(),
      });
      return [];
    }
    if (sql.includes('FROM usage') && sql.includes('WHERE u.user_id')) {
      const userId = params[0] as string;
      const limit = Number(params[1] ?? 20);
      return usageRows
        .filter((r) => r.user_id === userId)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          user_id: r.user_id,
          run_id: r.run_id,
          model: r.model,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          created_at: r.created_at,
        }));
    }

    throw new Error(`MemoryDb: unhandled query: ${sql}`);
  };

  return { db, users, sessions, runs, usageRows };
}
