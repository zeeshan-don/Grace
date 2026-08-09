// Vercel zero-config serverless function → GET /api/health
// Thin wrapper: the local dev server runs the same handler (src/api/handlers.ts).
// withHttp adds CORS, safe error responses and request logging (Milestone 12).
import { healthHandler } from '../src/api/handlers.ts';
import { withHttp } from '../src/api/middleware.ts';

export default withHttp(healthHandler);
