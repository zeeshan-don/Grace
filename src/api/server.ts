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
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = startApiServer(port);
  server.on('listening', () => {
    console.log(`GRACE API listening on http://localhost:${port}  (Ctrl+C to stop)`);
  });
}
