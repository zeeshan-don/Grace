// Vercel zero-config serverless function → POST/GET /api/usage
// Thin wrapper: the local dev server runs the same handler (src/api/handlers.ts).
import { usageHandler } from '../src/api/handlers.ts';
import { withHttp } from '../src/api/middleware.ts';

export default withHttp(usageHandler);
