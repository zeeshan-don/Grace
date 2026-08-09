/**
 * Shared HTTP types for the ZEESH AI API layer (Milestone 10).
 *
 * These mirror the subset of Vercel's Node.js serverless request/response API
 * that we use, so the same handlers run unchanged on Vercel (api/*.ts) and in
 * the local dev server (src/api/server.ts).
 */

/** Request as seen by handlers. Vercel populates `query`/`body`; the local adapter does too. */
export interface ApiRequest {
  method: string;
  /** Raw URL (may be absent in some runtimes). */
  url?: string;
  /** Path portion of the URL, e.g. "/api/health". */
  pathname?: string;
  /** Parsed query parameters. */
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (undefined when there is no JSON body). */
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): ApiResponse;
  json(data: unknown): void;
  send(text: string): void;
}

export type ApiHandler = (req: ApiRequest, res: ApiResponse) => Promise<void> | void;

/** True for plain JSON objects (not arrays, not null). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Respond 405 with the allowed methods. */
export function methodNotAllowed(res: ApiResponse, allow: string): void {
  res.setHeader('Allow', allow).status(405).json({ error: `Method not allowed. Use ${allow}.` });
}

/**
 * An intentional HTTP error with a designed, client-safe message (used by the
 * request adapter for body-size/JSON-parse failures). Other errors are
 * converted to a generic 500 by the middleware — never leaked to clients.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
