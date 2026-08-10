// Vercel zero-config serverless function → GET /api/session/status
// Server-authoritative free-session state (quota, expiry, provider/model).
import { sessionStatusHandler } from '../../src/api/handlers.ts';
import { withHttp } from '../../src/api/middleware.ts';

export default withHttp(sessionStatusHandler);
