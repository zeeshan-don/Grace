"""Context management for the coordinator (port of src/agents/compact.ts).

The coordinator only ever passes compact summaries between steps — never raw
tool dumps or full conversations. `compact_results` shrinks the accumulated
results to a token budget by truncating prose and dropping the oldest results
first.
"""

from grace.util_text import estimate_tokens

SUMMARY_CHARS = 600
FINDING_CHARS = 220


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = max_chars - 1
    return text[:max(0, cut)] + "…"


def render_result(result, budget_chars: int) -> str:
    lines = [f"- [{result.label}{' (failed)' if result.status == 'failed' else ''}] {_truncate(result.summary, budget_chars)}"]
    if result.files:
        lines.append(f"  files: {', '.join(result.files[:8])}")
    for f in result.findings[:3]:
        lines.append(f"  • {_truncate(f, FINDING_CHARS)}")
    for r in result.recommendations[:2]:
        lines.append(f"  → {_truncate(r, FINDING_CHARS)}")
    if result.error:
        lines.append(f"  error: {_truncate(result.error, 240)}")
    return "\n".join(lines)


def compact_results(results: list, budget_tokens: int) -> str:
    """Compact a list of results into one context string under a token budget.
    Deterministic: newer results are kept, older ones are truncated/dropped."""
    budget = max(200, budget_tokens)
    blocks: list[str] = []
    used = 0
    # Walk newest-first so the most relevant (last) results survive compaction.
    for result in reversed(results):
        if result.status == "skipped":
            continue
        block = render_result(result, SUMMARY_CHARS)
        cost = estimate_tokens(block)
        if used + cost > budget and blocks:
            break  # drop oldest results
        # Degrade the summary further for very large results.
        while used + estimate_tokens(block) > budget and len(block) > 160:
            block = _truncate(block, len(block) // 2)
        # Hard clamp: even a short block must fit the remaining budget.
        if used + estimate_tokens(block) > budget:
            block = _truncate(block, max(80, budget - used))
        blocks.insert(0, block)
        used += estimate_tokens(block)
    return "\n".join(blocks)


def compact_text(text: str, max_chars: int) -> str:
    """Compact arbitrary free text to a char cap (used for planner context)."""
    if len(text) <= max_chars:
        return text
    head = text[:int(max_chars * 0.7)]
    tail = text[-int(max_chars * 0.3):]
    return f"{head}\n… [context truncated, {len(text) - max_chars} chars omitted] …\n{tail}"
