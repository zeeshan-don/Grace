/**
 * Minimal routing + node:http adapter for the local dev server.
 *
 * Vercel does not use this file — each `api/*.ts` entrypoint exports its
 * handler directly — but the local server shares the same handlers through
 * this router so behavior is identical in both runtimes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { healthHandler, loginHandler, logoutHandler, meHandler, providerHandler, registerHandler, usageHandler } from './handlers.ts';
import { logApiEvent } from './log.ts';
import { applyCors, withHttp } from './middleware.ts';
import { HttpError, type ApiHandler, type ApiRequest, type ApiResponse } from './types.ts';

interface Route {
  method: 'GET' | 'POST' | 'ANY';
  pattern: string;
  handler: ApiHandler;
  /** Methods advertised in the Allow header when the method doesn't match. */
  allow: string[];
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/health', handler: healthHandler, allow: ['GET'] },
  { method: 'POST', pattern: '/api/auth/register', handler: registerHandler, allow: ['POST'] },
  { method: 'POST', pattern: '/api/auth/login', handler: loginHandler, allow: ['POST'] },
  { method: 'POST', pattern: '/api/auth/logout', handler: logoutHandler, allow: ['POST'] },
  { method: 'GET', pattern: '/api/auth/me', handler: meHandler, allow: ['GET'] },
  { method: 'ANY', pattern: '/api/usage', handler: usageHandler, allow: ['GET', 'POST'] },
  { method: 'POST', pattern: '/api/provider', handler: providerHandler, allow: ['POST'] },
];

/** Find a handler for a method + pathname, or null (→ 404/405). */
export function matchRoute(method: string, pathname: string): ApiHandler | null {
  for (const route of ROUTES) {
    if (route.pattern !== pathname) continue;
    if (route.method === 'ANY' || route.method === method) return route.handler;
  }
  return null;
}

/** Allowed methods for a known path, or null when the path is unknown. */
function allowedMethods(pathname: string): string[] | null {
  for (const route of ROUTES) {
    if (route.pattern === pathname) return route.allow;
  }
  return null;
}

const MAX_BODY_BYTES = 1_000_000;

/** Adapter: node:http request/response → ApiRequest/ApiResponse. */
export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiRes = createApiResponse(res);
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const apiReq: ApiRequest = {
      method: req.method ?? 'GET',
      url: req.url,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: await readBody(req),
    };
    const handler = matchRoute(apiReq.method, url.pathname);
    if (!handler) {
      const startedAt = Date.now();
      applyCors(apiRes);
      const allow = allowedMethods(url.pathname);
      if (allow) {
        const status = 405;
        apiRes
          .setHeader('Allow', allow.join(', '))
          .status(status)
          .json({ error: `Method not allowed. Use ${allow.join(', ')}.` });
        logApiEvent({ method: apiReq.method, path: url.pathname, status, latencyMs: Date.now() - startedAt });
        return;
      }
      apiRes.status(404).json({ error: 'Not found.' });
      logApiEvent({ method: apiReq.method, path: url.pathname, status: 404, latencyMs: Date.now() - startedAt });
      return;
    }
    // Same middleware as the Vercel entrypoints (api/*.ts): CORS, safe
    // errors, request logging — identical behavior locally and in production.
    await withHttp(handler)(apiReq, apiRes);
  } catch (err) {
    // Safety net for the request-shaping step (URL parsing, body reads);
    // handler errors are already contained by withHttp.
    applyCors(apiRes);
    if (err instanceof HttpError) {
      // Observability (M12): even shape-level 4xx/5xx get a log line.
      logApiEvent({
        method: req.method ?? 'GET',
        path: urlPath(req.url),
        status: err.status,
        latencyMs: 0,
        detail: err.message,
      });
      return void apiRes.status(err.status).json({ error: err.message });
    }
    apiRes.status(500).json({ error: 'Internal server error.' });
  }
}

function urlPath(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'http://localhost').pathname;
  } catch {
    return '/unknown';
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (!type.includes('json')) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function createApiResponse(res: ServerResponse): ApiResponse {
  const apiRes: ApiResponse = {
    status(code) {
      res.statusCode = code;
      return apiRes;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return apiRes;
    },
    json(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    },
    send(text) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(text);
    },
  };
  return apiRes;
}
