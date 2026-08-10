// Vercel zero-config serverless function → POST /api/session/end
// Explicitly ends the user's active free session (server-authoritative).
import { endSessionHandler } from '../../src/api/handlers.ts';
import { withHttp } from '../../src/api/middleware.ts';

export default withHttp(endSessionHandler);
