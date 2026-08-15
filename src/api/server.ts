/**
 * Local dev server for the GRACE API (Milestone 10).
 *
 *   npm run serve        → http://localhost:8787
 *   curl localhost:8787/api/health
 *
 * Shares the exact same handlers as the Vercel functions (api/*.ts), so
 * behavior is identical locally and in production.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../config/config.ts';
import { handleHttp } from './router.ts';

export const DEFAULT_PORT = 8787;

/** Create the HTTP server without listening (used by tests and startApiServer). */
export function createApiServer(): Server {
  return createServer((req, res) => {
    void handleHttp(req, res);
  });
}

/** Create and start listening on the given port. */
export function startApiServer(port: number): Server {
  const server = createApiServer();
  server.listen(port);
  return server;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  loadEnv(process.cwd());
  if (!process.env.DATABASE_URL?.trim()) {
    // Local dev without a database: auth/usage endpoints will return 503. Warn
    // loudly instead of failing silently — DATABASE_URL is server-side only
    // (never read by the CLI), so it belongs in .env here or in the Vercel
    // project environment for deployments.
    console.warn(
      'Warning: DATABASE_URL is not set — auth and usage endpoints will return 503. ' +
        'Add it to .env (local dev) or the Vercel environment (production).',
    );
  }
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = startApiServer(port);
  server.on('listening', () => {
    console.log(`GRACE API listening on http://localhost:${port}  (Ctrl+C to stop)`);
  });
}
