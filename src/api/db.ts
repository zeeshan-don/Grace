/**
 * Neon PostgreSQL client (Milestone 10).
 *
 * The connection string is read from DATABASE_URL — a server-side secret that
 * is never sent to the CLI or the browser. The client is created lazily so the
 * API boots and serves /api/health even when no database is configured
 * (health reports database: "not_configured").
 */
import { neon } from '@neondatabase/serverless';

/** A row returned by the database. */
export type Row = Record<string, unknown>;

/**
 * The tiny surface of the Neon driver we rely on. The `neon()` client is a
 * tagged-template callable; its documented string-query API is the `.query()`
 * method, so getDb() adapts it to this simple `(query, params)` signature.
 * Keeping the interface minimal makes the service trivially testable with a
 * fake client.
 */
export interface Db {
  (query: string, params?: unknown[]): Promise<Row[]>;
}

/** The documented string-query surface of the Neon client we use. */
interface NeonClientQuery {
  query(query: string, params?: unknown[]): Promise<Row[]>;
}

let client: Db | null = null;

/** Create (once) or return the shared client for the given connection string. */
export function getDb(connectionString: string | undefined = process.env.DATABASE_URL?.trim()): Db | null {
  if (connectionString && !client) {
    const raw = neon(connectionString) as unknown as NeonClientQuery;
    client = (query: string, params: unknown[] = []) => raw.query(query, params);
  }
  return client;
}

/** Test hook: replace the shared client (used by tests/api.test.ts). */
export function setDbForTests(db: Db | null): void {
  client = db;
}
