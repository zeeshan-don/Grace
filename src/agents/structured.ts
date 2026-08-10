/**
 * Structured result parsing (subagent coordinator).
 *
 * Most agents end their final message with a JSON object
 * `{ summary, files, findings, recommendations }`. Parsing is best-effort:
 * malformed/absent JSON degrades to the raw final text as the summary, so the
 * coordinator never crashes on a sloppy model.
 */
export interface StructuredResult {
  summary?: string;
  files?: string[];
  findings?: string[];
  recommendations?: string[];
}

/** Extract the last balanced JSON object from a string (brace counting). */
export function extractLastJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '}') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '{') {
      depth -= 1;
      if (depth === 0 && start !== -1) return text.slice(i, start + 1);
    }
  }
  return null;
}

export function parseStructuredResult(text: string): StructuredResult | null {
  const candidate = extractLastJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as StructuredResult;
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Require at least one recognized field so random JSON in prose isn't
    // mistaken for a result block.
    if (!('summary' in parsed) && !('files' in parsed) && !('findings' in parsed) && !('recommendations' in parsed)) {
      return null;
    }
    const clean = <T>(v: T | undefined, guard: (x: T) => boolean): T | undefined =>
      v !== undefined && guard(v) ? v : undefined;
    const strArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : undefined;
    return {
      summary: clean(parsed.summary, (x): x is string => typeof x === 'string')?.slice(0, 2_000),
      files: strArray(parsed.files),
      findings: strArray(parsed.findings)?.map((s) => s.slice(0, 400)),
      recommendations: strArray(parsed.recommendations)?.map((s) => s.slice(0, 400)),
    };
  } catch {
    return null;
  }
}
