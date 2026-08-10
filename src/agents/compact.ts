import { estimateTokens } from '../util/text.ts';
import type { SubagentResult } from './types.ts';

/**
 * Context management (subagent coordinator).
 *
 * The coordinator only ever passes compact summaries between steps — never
 * raw tool dumps or full conversations. `compactResults` shrinks the
 * accumulated results to a token budget by truncating prose and dropping the
 * oldest results first, so subagents stay small and TPM limits are never hit.
 */

const SUMMARY_CHARS = 600;
const FINDING_CHARS = 220;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Avoid splitting a UTF-16 surrogate pair (no lone surrogates in output).
  let cut = max - 1;
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return text.slice(0, Math.max(0, cut)) + '…';
}

/** Render one result as a compact context block. */
export function renderResult(result: SubagentResult, budgetChars: number): string {
  const lines: string[] = [];
  lines.push(`- [${result.label}${result.status === 'failed' ? ' (failed)' : ''}] ${truncate(result.summary, budgetChars)}`);
  if (result.files.length > 0) lines.push(`  files: ${result.files.slice(0, 8).join(', ')}`);
  for (const f of result.findings.slice(0, 3)) lines.push(`  • ${truncate(f, FINDING_CHARS)}`);
  for (const r of result.recommendations.slice(0, 2)) lines.push(`  → ${truncate(r, FINDING_CHARS)}`);
  if (result.error) lines.push(`  error: ${truncate(result.error, 240)}`);
  return lines.join('\n');
}

/**
 * Compact a list of results into one context string under a token budget.
 * Deterministic: newer results are kept, older ones are truncated/dropped.
 */
export function compactResults(results: SubagentResult[], budgetTokens: number): string {
  const budget = Math.max(200, budgetTokens);
  const blocks: string[] = [];
  let used = 0;
  // Walk newest-first so the most relevant (last) results survive compaction.
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const result = results[i] as SubagentResult;
    if (result.status === 'skipped') continue;
    let block = renderResult(result, SUMMARY_CHARS);
    const cost = estimateTokens(block);
    if (used + cost > budget && blocks.length > 0) break; // drop oldest results
    // Degrade the summary further for very large results.
    while (used + estimateTokens(block) > budget && block.length > 160) {
      block = truncate(block, Math.floor(block.length / 2));
    }
    // Hard clamp: even a short block must fit the remaining budget.
    if (used + estimateTokens(block) > budget) {
      block = truncate(block, Math.max(80, budget - used));
    }
    blocks.unshift(block);
    used += estimateTokens(block);
  }
  return blocks.join('\n');
}

/** Compact arbitrary free text to a char cap (used for planner context). */
export function compactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n… [context truncated, ${text.length - maxChars} chars omitted] …\n${tail}`;
}
