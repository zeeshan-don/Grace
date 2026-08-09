// Vercel zero-config serverless function → GET /api/auth/me
// Thin wrapper: the local dev server runs the same handler (src/api/handlers.ts).
import { meHandler } from '../../src/api/handlers.ts';
import { withHttp } from '../../src/api/middleware.ts';

export default withHttp(meHandler);
