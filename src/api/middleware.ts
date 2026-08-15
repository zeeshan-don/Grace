/**
 * Shared HTTP middleware (Milestone 12): CORS + preflight, secret-safe error
 * handling and request logging. Applied to every route on both the local dev
 * server (src/api/router.ts) and the Vercel functions (api/*.ts), so behavior
 * is identical locally and in production.
 */
import { logApiEvent } from './log.ts';
import { HttpError, type ApiHandler, type ApiRequest, type ApiResponse } from './types.ts';

/**
 * True when a Postgres error means the schema is missing or mismatched
 * (an unapplied/partial migration), so the failure is actionable rather than
 * a mystery 500:
 *   - 42P01 undefined_table     (e.g. relation "daily_cost" does not exist)
 *   - 42703 undefined_column    (a column referenced by a query is missing)
 * Never triggers for connection/auth/query errors — those stay generic 500s.
 */
function isPostgresSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703';
}

/** CORS origin for browser clients; default '*' (the CLI is not a browser and is unaffected). */
export function corsOrigin(): string {
  return process.env.ZEESH_CORS_ORIGIN?.trim() || '*';
}

/** Set CORS headers on a response (idempotent). */
export function applyCors(res: ApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin());
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Vary', 'Origin');
}

/**
 * Wrap a handler with:
 *   - CORS headers + OPTIONS preflight (204),
 *   - safe error responses (no stack traces or internals reach clients;
 *     sanitized details go to the log only),
 *   - a request log line (method, path, status, latency, plus any detail the
 *     handler chose to emit through logApiEvent).
 */
export function withHttp(handler: ApiHandler): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse): Promise<void> => {
    const startedAt = Date.now();
    let status = 200;
    let errorDetail: string | undefined;

    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      logApiEvent({ method: req.method, path: req.pathname ?? req.url ?? '/', status: 204, latencyMs: Date.now() - startedAt });
      return;
    }

    // Capture the status the handler sets (both runtimes' res expose .status()).
    const originalStatus = res.status.bind(res);
    res.status = (code: number): ApiResponse => {
      status = code;
      return originalStatus(code);
    };

    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        // Intentional 4xx/5xx with a designed message (e.g. body too large).
        status = err.status;
        res.status(err.status).json({ error: err.message });
      } else if (isPostgresSchemaError(err)) {
        // The server DB is missing a table/column — almost always an unapplied
        // migration, not a code bug. Give ops a clear, secret-free pointer
        // instead of a silent 500 (which the CLI would read as a mystery
        // failure). The concrete SQLSTATE goes to the log only.
        status = 503;
        errorDetail = err instanceof Error ? err.message : String(err);
        res.status(503).json({
          error:
            'The server database is missing required tables or columns — run the database migrations (db/migrations/*.sql) and redeploy. Details were logged server-side.',
        });
      } else {
        // Unexpected failure: never leak internals to the client.
        status = 500;
        errorDetail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Internal server error.' });
      }
    } finally {
      logApiEvent({
        method: req.method,
        path: req.pathname ?? req.url ?? '/',
        status,
        latencyMs: Date.now() - startedAt,
        detail: errorDetail,
      });
    }
  };
}
