"""GRACE backend server (Python port of src/api + api/*).

Serves the same API contract as the TypeScript backend (Milestones 10-18):

  GET  /api/health           liveness + config probe
  POST /api/auth/register    create account + session
  POST /api/auth/login       verify credentials + session
  POST /api/auth/logout      invalidate a session
  GET  /api/auth/me          current user
  GET  /api/usage            recent usage + daily session state
  POST /api/usage            record one agent run
  POST /api/provider         proxy a chat completion (server-side keys)
  GET  /api/session/status   free-session state (read-only)
  POST /api/session/end      explicitly end the active free session

The server is a thin WSGI application (`grace.server.wsgi.wsgi_app`). The
local dev server (`python -m grace.server.serve`) and the Vercel functions
(`api/*.py`) share the exact same handlers, so behavior is identical in both
runtimes — mirroring the original TS design where api/*.ts and the local
node:http server shared src/api/handlers.ts.

Server secrets (provider keys, DATABASE_URL) live here — server-side only.
The CLI never imports this package; it talks to the backend over HTTP and
only ever sends its own session token.
"""
