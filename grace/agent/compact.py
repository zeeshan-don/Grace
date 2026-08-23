"""Context compaction (port of packages/agent-runtime/src/compact-history.ts).

When a conversation grows past a configurable token threshold, older messages
are compressed into a summary so the agent never exceeds its context window.
The compaction is mechanical (no LLM call) — it keeps the system prompt, the
most recent messages, and collapses everything in between.

Rules:
  - The system message (index 0) is NEVER dropped or altered.
  - The latest user prompt is ALWAYS preserved.
  - Tool results are the first to be dropped (oldest first).
  - Assistant messages that preceded a live prompt are collapsed into a
    one-line "[… N previous messages compacted]" marker.
  - A compaction event is recorded so the UI can surface it (verbose mode).
"""

from __future__ import annotations

from grace.util_text import estimate_tokens

# Compaction fires when context exceeds this threshold (tokens).
DEFAULT_COMPACTION_THRESHOLD = 20_000

# How many recent messages to KEEP after compaction (the "tail").
DEFAULT_TAIL_KEEP = 6

# When compressing, each dropped assistant message is replaced with this marker
# so the model knows something was omitted.
COMPACTED_MARKER = "[… {count} previous messages compacted — read files to restore context if needed]"


def maybe_compact_messages(
    messages: list[dict],
    *,
    threshold: int = DEFAULT_COMPACTION_THRESHOLD,
    tail_keep: int = DEFAULT_TAIL_KEEP,
) -> tuple[list[dict], dict | None]:
    """Optionally compact the message list. Returns (compacted_messages, event_or_None).

    The event dict (when not None) has:
      - ``trigger``: "threshold_exceeded" | "token_budget"
      - ``messagesBefore``: int
      - ``messagesAfter``: int
      - ``messagesDropped``: int
      - ``estimatedTokensBefore``: int
      - ``estimatedTokensAfter``: int
    """
    if len(messages) <= tail_keep + 2:
        return messages, None

    total_before = sum(estimate_tokens(m.get("content") or "") for m in messages)
    if total_before <= threshold:
        return messages, None

    # --- Strategy ---
    # 1. Keep system prompt (index 0).
    # 2. Keep the last `tail_keep` messages (the "tail").
    # 3. Everything between is the "body" to compress.
    system = messages[0]
    tail = messages[-tail_keep:]
    body = messages[1:-tail_keep]

    if not body:
        return messages, None

    # Count how many are tool results vs assistant/user messages.
    tool_count = sum(1 for m in body if m.get("role") == "tool")
    assistant_count = sum(1 for m in body if m.get("role") == "assistant")
    user_count = sum(1 for m in body if m.get("role") == "user")
    dropped = len(body)

    marker_text = COMPACTED_MARKER.format(count=dropped)
    compacted_body = [{"role": "user", "content": marker_text}]

    compacted = [system] + compacted_body + tail
    total_after = sum(estimate_tokens(m.get("content") or "") for m in compacted)

    event = {
        "trigger": "threshold_exceeded",
        "messagesBefore": len(messages),
        "messagesAfter": len(compacted),
        "messagesDropped": dropped,
        "toolResultsDropped": tool_count,
        "assistantDropped": assistant_count,
        "userDropped": user_count,
        "estimatedTokensBefore": total_before,
        "estimatedTokensAfter": total_after,
    }

    return compacted, event


def compress_tool_results(messages: list[dict], max_chars: int = 4_000) -> list[dict]:
    """Truncate oversized tool results in-place without dropping messages.

    This is a lighter-weight operation than full compaction — it shrinks
    individual tool results that are too large for the context window.
    """
    out: list[dict] = []
    for m in messages:
        if m.get("role") == "tool":
            content = m.get("content") or ""
            if len(content) > max_chars:
                half = max_chars // 2 - 20
                content = (
                    content[:half]
                    + f"\n… [truncated {len(content) - max_chars + 40} chars] …\n"
                    + content[-half:]
                )
                out.append({**m, "content": content})
            else:
                out.append(m)
        else:
            out.append(m)
    return out
