/**
 * Provider error taxonomy.
 *
 * Every provider implementation (Groq, NVIDIA, …) throws `ProviderError`
 * when a model request fails, so callers can distinguish *why* it failed:
 *
 *   - authentication    — the server-side API key was rejected (401/403)
 *   - rate_limit        — quota/TPM/RPM hit (429)
 *   - timeout           — the provider did not answer in time (408 / abort)
 *   - unavailable_model — the requested model does not exist / is not served
 *   - malformed_response— the provider answered with unparseable garbage
 *   - network           — the provider could not be reached (DNS/TLS/conn)
 *   - unknown           — anything else
 *
 * Messages are always built from safe, static text plus scrubbed provider
 * detail — never raw SDK output that could echo an API key. The server
 * (src/api/providers.ts) maps categories to user-safe responses and HTTP
 * statuses; the CLI never sees a provider key.
 */
import { redactSecrets } from '../safety/policy.ts';

export type ProviderErrorCategory =
  | 'authentication'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'timeout'
  | 'unavailable_model'
  | 'server_error'
  | 'malformed_response'
  | 'network'
  | 'unknown';

export class ProviderError extends Error {
  /** Provider id that failed (e.g. 'nvidia'). */
  readonly providerId: string;
  readonly category: ProviderErrorCategory;
  /** HTTP status from the provider (0 for network/timeout/local errors). */
  readonly status: number;

  constructor(providerId: string, category: ProviderErrorCategory, message: string, status = 0) {
    super(message);
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.category = category;
    this.status = status;
  }

  /** Wrap an arbitrary thrown value into a ProviderError (sanitized, 'unknown'). */
  static wrap(providerId: string, err: unknown, fallback = 'The AI provider request failed.'): ProviderError {
    if (err instanceof ProviderError) return err;
    const raw = err instanceof Error ? err.message : String(err);
    return new ProviderError(providerId, 'unknown', scrub(raw) || fallback);
  }
}

/** Scrub free provider text (could echo credentials) before it is stored/shown. */
export function scrub(text: string): string {
  return redactSecrets(text).slice(0, 400).trim();
}

/** Short, human-safe label for a category (used in aggregated failure text). */
export function describeCategory(category: ProviderErrorCategory): string {
  switch (category) {
    case 'authentication':
      return 'authentication failed';
    case 'rate_limit':
      return 'rate limit hit';
    case 'quota_exhausted':
      return 'quota exhausted';
    case 'timeout':
      return 'timed out';
    case 'unavailable_model':
      return 'model unavailable';
    case 'server_error':
      return 'provider outage';
    case 'malformed_response':
      return 'malformed response';
    case 'network':
      return 'network failure';
    default:
      return 'request failed';
  }
}

/**
 * Provider-level failures that should activate the fallback router.
 *
 * These are the ONLY categories that may switch providers: genuine
 * provider-level problems (quota exhausted, confirmed rate limit, provider
 * unavailable/outage, model unavailable, sustained server errors, capacity
 * errors). Task/model/tool failures — malformed tool arguments, invalid tool
 * calls, failed commands, a difficult question — are NOT provider errors;
 * they never surface as a `ProviderError` from the provider boundary (they
 * are handled inside the agent loop), so they can never trigger fallback.
 */
export function isFallbackEligible(category: ProviderErrorCategory): boolean {
  switch (category) {
    case 'rate_limit':
    case 'quota_exhausted':
    case 'timeout':
    case 'unavailable_model':
    case 'server_error':
    case 'malformed_response':
    case 'network':
      return true;
    case 'authentication':
    case 'unknown':
      // Authentication can be provider-specific (one key invalid, others
      // fine) — fall through to the next provider too. `unknown` is wrapped
      // as a provider-level failure by construction (ProviderError.wrap).
      return true;
  }
}

/** User-facing (secret-safe) description of a provider failure. */
export function describeProviderError(err: ProviderError): string {
  switch (err.category) {
    case 'authentication':
      return 'The AI provider rejected the server-side API key (authentication failed).';
    case 'rate_limit':
      return 'The AI provider rate limit was hit — wait a moment and retry.';
    case 'quota_exhausted':
      return 'The AI provider quota is exhausted for this account — the router tries the next provider automatically.';
    case 'timeout':
      return 'The AI provider request timed out — retry.';
    case 'unavailable_model':
      return 'The requested model is unavailable on the AI provider — pick a different model with /model.';
    case 'server_error':
      return 'The AI provider is experiencing an outage — the router tries the next provider automatically.';
    case 'malformed_response':
      return 'The AI provider returned a malformed response — retry.';
    case 'network':
      return 'Could not reach the AI provider (network failure) — check connectivity and retry.';
    default:
      return 'The AI provider request failed.';
  }
}

/**
 * HTTP status the API should answer with for a given category. Rate limits
 * surface as 429 (the CLI treats 429 as "wait and retry"); timeouts as 504;
 * everything else stays a generic 502.
 */
export function statusForCategory(category: ProviderErrorCategory): number {
  if (category === 'rate_limit' || category === 'quota_exhausted') return 429;
  if (category === 'timeout') return 504;
  return 502;
}
