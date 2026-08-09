// Vercel zero-config serverless function → POST /api/auth/login
// Thin wrapper: the local dev server runs the same handler (src/api/handlers.ts).
import { loginHandler } from '../../src/api/handlers.ts';
import { withHttp } from '../../src/api/middleware.ts';

export default withHttp(loginHandler);
