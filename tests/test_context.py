"""Context management tests (port of tests/context.test.ts)."""

from grace.agent.context import task_scope_hint, trim_messages
from grace.util_text import estimate_tokens


def test_estimate_tokens_is_roughly_chars_over_4():
    assert estimate_tokens("abcd") == 1
    assert 95 <= estimate_tokens("x" * 400) <= 105


def test_trim_messages_keeps_system_and_drops_oldest_tool_results():
    def big(chars):
        return "x" * chars

    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "first request"},
        {"role": "assistant", "content": big(1000)},
        {"role": "tool", "content": big(4000)},
        {"role": "assistant", "content": big(1000)},
        {"role": "tool", "content": big(4000)},
        {"role": "assistant", "content": big(1000)},
        {"role": "tool", "content": big(4000)},
        {"role": "assistant", "content": "final answer"},
    ]
    budget = 3000
    trimmed = trim_messages(messages, budget)
    total = sum(estimate_tokens(m.get("content") or "") for m in trimmed)
    assert total <= budget + 500, f"trimmed total {total} exceeds budget {budget}"
    assert trimmed[0]["role"] == "system"
    assert trimmed[1]["role"] == "user"
    assert len(trimmed) < len(messages), "should have dropped old messages"
    assert trimmed[-1]["content"] == "final answer"


def test_trim_messages_truncates_oversized_tool_results():
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "ok", "tool_calls": [{"id": "c1", "name": "read_file", "arguments": "{}"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "x" * 50_000},
    ]
    trimmed = trim_messages(messages, 100_000)
    tool_msg = trimmed[-1]
    assert len(tool_msg.get("content") or "") <= 8_500, "tool content should be truncated"
    assert "truncated" in (tool_msg.get("content") or "")


def test_task_scope_hint_targets_named_files():
    hint = task_scope_hint("Inspect package.json and find bugs")
    assert "package.json" in hint
    assert "Task scope (targeted)" in hint
    # Must not suggest browsing the whole repo.
    assert "Do NOT browse the repository" in hint


def test_task_scope_hint_empty_for_broad_tasks():
    assert task_scope_hint("fix the authentication flow") == ""
    assert task_scope_hint("explain the whole project") == ""
