// Vercel zero-config serverless function → POST /api/provider
// Proxies chat completions through the server-side provider layer; the
// provider API key never leaves the server.
import { providerHandler } from '../src/api/handlers.ts';
import { withHttp } from '../src/api/middleware.ts';

export default withHttp(providerHandler);
