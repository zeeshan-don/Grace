/**
 * Shared HTTP middleware (Milestone 12): CORS + preflight, secret-safe error
 * handling and request logging. Applied to every route on both the local dev
 * server (src/api/router.ts) and the Vercel functions (api/*.ts), so behavior
 * is identical locally and in production.
 */
import { logApiEvent } from './log.ts';
import { HttpError, type ApiHandler, type ApiRequest, type ApiResponse } from './types.ts';

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
