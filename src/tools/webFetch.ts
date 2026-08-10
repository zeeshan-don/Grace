import { truncateMiddle } from '../util/text.ts';
import type { Tool } from './registry.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CHARS = 20_000;

/**
 * Fetch a public web page and return readable text (researcher role).
 *
 * Uses the platform `fetch` — no new dependency — and is strictly read-only
 * (GET only, no redirects to file: URLs, no cookies). HTML is stripped to
 * readable text so the researcher gets concise content without markup noise.
 */
export function createWebFetchTool(_ctx: { projectRoot: string }): Tool {
  return {
    name: 'web_fetch',
    description: 'Fetch a public HTTP(S) URL and return its readable text. Read-only; best for docs and reference pages.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
        maxChars: { type: 'number', description: 'Response cap in chars (default 20000).' },
      },
      required: ['url'],
    },
    async execute(args) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) return 'Error: "url" must be a full http(s) URL.';
      const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.min(args.maxChars, MAX_CHARS) : MAX_CHARS;

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': 'zeesh-researcher/0.1' },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          redirect: 'follow',
        });
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        return `Error: could not fetch ${url} (${isTimeout ? 'timed out' : (err as Error).message}).`;
      }
      if (!res.ok) return `Error: ${url} returned HTTP ${res.status}.`;
      if (res.status === 204) return '(empty response)';
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > 10 * 1024 * 1024) return `Error: ${url} is too large (${Math.round(contentLength / 1024 / 1024)} MB).`;

      const text = await res.text().catch(() => '');
      const readable = stripHtml(text).trim();
      if (!readable) return '(page contains no readable text)';
      return truncateMiddle(readable, maxChars);
    },
  };
}

/** Crude but effective HTML→text: drops scripts/styles/tags and collapses whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?!\/?(p|br|li|h[1-6]|pre|code|tr|div)\b)[^>]*>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|code)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
}
