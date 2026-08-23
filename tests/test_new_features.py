"""Tests for all new Freebuff-style features ported to Grace."""

import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from grace.agent.compact import compress_tool_results, maybe_compact_messages
from grace.agent.loop import AbortSignal, AgentLoop
from grace.agent.steering import SteeringQueue
from grace.providers.errors import ProviderError
from grace.providers.fallback import FallbackProvider
from grace.providers.types import ChatResult
from grace.tools.ask_user import _execute_ask_user
from grace.tools.skill import _discover_skills, _load_skill
from grace.tools.suggest_followups import _execute_suggest_followups

# ─── 1. Context Compaction ────────────────────────────────────────────────


class TestContextCompaction:
    def test_no_compaction_under_threshold(self):
        messages = [
            {"role": "system", "content": "You are GRACE."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hey!"},
        ]
        compacted, event = maybe_compact_messages(messages, threshold=10_000)
        assert event is None
        assert len(compacted) == 3

    def test_compaction_fires_over_threshold(self):
        messages = [{"role": "system", "content": "You are GRACE."}]
        for i in range(50):
            messages.append({"role": "user", "content": f"Message {i} " + "x" * 200})
            messages.append({"role": "assistant", "content": f"Reply {i} " + "y" * 200})
        compacted, event = maybe_compact_messages(messages, threshold=5_000, tail_keep=6)
        assert event is not None
        assert event["messagesDropped"] > 0
        assert event["estimatedTokensAfter"] < event["estimatedTokensBefore"]
        assert len(compacted) < len(messages)
        assert compacted[0]["role"] == "system"
        assert compacted[-1]["role"] == "assistant"
        assert "Reply 49" in compacted[-1]["content"]

    def test_system_prompt_never_dropped(self):
        messages = [{"role": "system", "content": "IMPORTANT SYSTEM PROMPT"}]
        for i in range(30):
            messages.append({"role": "user", "content": "x" * 300})
            messages.append({"role": "assistant", "content": "y" * 300})
        compacted, event = maybe_compact_messages(messages, threshold=2_000)
        assert compacted[0]["content"] == "IMPORTANT SYSTEM PROMPT"

    def test_compacted_marker_visible(self):
        messages = [{"role": "system", "content": "sys"}]
        for i in range(20):
            messages.append({"role": "user", "content": "x" * 200})
            messages.append({"role": "assistant", "content": "y" * 200})
        compacted, event = maybe_compact_messages(messages, threshold=2_000, tail_keep=4)
        marker_found = any("compacted" in m.get("content", "").lower() for m in compacted)
        assert marker_found

    def test_compress_tool_results(self):
        messages = [
            {"role": "tool", "content": "x" * 10_000},
            {"role": "assistant", "content": "normal"},
        ]
        compressed = compress_tool_results(messages, max_chars=4_000)
        assert len(compressed[0]["content"]) < 10_000
        assert "truncated" in compressed[0]["content"]
        assert compressed[1]["content"] == "normal"

    def test_short_tool_results_not_truncated(self):
        messages = [{"role": "tool", "content": "short result"}]
        compressed = compress_tool_results(messages, max_chars=4_000)
        assert compressed[0]["content"] == "short result"


# ─── 2. Skill System ──────────────────────────────────────────────────────


class TestSkillSystem:
    def test_discover_skills_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            skills = _discover_skills(tmpdir)
            assert skills == []

    def test_discover_skills(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            skills_dir = Path(tmpdir) / ".agents" / "skills"
            skills_dir.mkdir(parents=True)
            (skills_dir / "my-skill.md").write_text("# My Skill\n\nDo stuff.")
            (skills_dir / "another.md").write_text("# Another\n\nOther stuff.")
            skills = _discover_skills(tmpdir)
            assert len(skills) == 2
            names = {s["name"] for s in skills}
            assert "my-skill" in names
            assert "another" in names

    def test_load_skill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            skills_dir = Path(tmpdir) / ".agents" / "skills"
            skills_dir.mkdir(parents=True)
            (skills_dir / "test-skill.md").write_text("# Test Skill\n\nInstructions here.")
            content = _load_skill(tmpdir, "test-skill")
            assert content is not None
            assert "# Test Skill" in content
            assert "Instructions here." in content

    def test_load_skill_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            assert _load_skill(tmpdir, "nonexistent") is None


# ─── 3. Suggest Followups ─────────────────────────────────────────────────


class TestSuggestFollowups:
    def test_returns_formatted_suggestions(self):
        args = {
            "followups": [
                {"prompt": "Add unit tests", "label": "Add tests"},
                {"prompt": "Refactor the auth module", "label": "Refactor auth"},
            ]
        }
        result = _execute_suggest_followups(args, MagicMock())
        assert "Add tests" in result
        assert "Refactor auth" in result
        assert "Suggested followups" in result

    def test_empty_followups(self):
        result = _execute_suggest_followups({"followups": []}, MagicMock())
        assert "No followups" in result

    def test_invalid_input(self):
        result = _execute_suggest_followups({"followups": "not a list"}, MagicMock())
        assert "Error" in result


# ─── 4. Ask User ──────────────────────────────────────────────────────────


class TestAskUser:
    def test_requires_question(self):
        result = _execute_ask_user({"options": [{"label": "A"}]}, MagicMock())
        assert "Error" in result

    def test_requires_two_options(self):
        result = _execute_ask_user({"question": "Q", "options": [{"label": "A"}]}, MagicMock())
        assert "Error" in result

    def test_uses_callback_when_available(self):
        ctx = MagicMock()
        ctx._ask_user = MagicMock(return_value="Option A")
        result = _execute_ask_user(
            {"question": "Pick one", "options": [{"label": "A"}, {"label": "B"}]},
            ctx,
        )
        assert "Option A" in result
        ctx._ask_user.assert_called_once()

    def test_returns_skip_when_callback_returns_none(self):
        ctx = MagicMock()
        ctx._ask_user = MagicMock(return_value=None)
        result = _execute_ask_user(
            {"question": "Q", "options": [{"label": "A"}, {"label": "B"}]},
            ctx,
        )
        assert "skipped" in result.lower()


# ─── 5. Steering ───────────────────────────────────────────────────────────


class TestSteering:
    def test_push_and_drain(self):
        q = SteeringQueue()
        q.push("message 1")
        q.push("message 2")
        drained = q.drain()
        assert drained == ["message 1", "message 2"]
        assert q.drain() == []

    def test_has_pending(self):
        q = SteeringQueue()
        assert not q.has_pending
        q.push("hi")
        assert q.has_pending
        q.drain()
        assert not q.has_pending

    def test_pending_count(self):
        q = SteeringQueue()
        assert q.pending_count == 0
        q.push("a")
        q.push("b")
        assert q.pending_count == 2
        q.drain()
        assert q.pending_count == 0

    def test_thread_safety(self):
        q = SteeringQueue()
        errors = []

        def pusher(n):
            try:
                for i in range(100):
                    q.push(f"msg-{n}-{i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=pusher, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors
        drained = q.drain()
        assert len(drained) == 400

    def test_clear(self):
        q = SteeringQueue()
        q.push("a")
        q.push("b")
        q.clear()
        assert not q.has_pending
        assert q.drain() == []


# ─── 6. Fallback Provider (production-grade) ──────────────────────────────


class TestFallbackProvider:
    def _make_provider(self, provider_id, succeeds=True, error_category=None):
        p = MagicMock()
        p.id = provider_id
        p.label = f"Provider {provider_id}"
        if succeeds:
            p.chat.return_value = ChatResult(content=f"Response from {provider_id}")
        else:
            p.chat.side_effect = ProviderError(
                provider_id, error_category or "rate_limit", f"{provider_id} rate limited"
            )
        return p

    def test_primary_succeeds(self):
        p1 = self._make_provider("groq")
        p2 = self._make_provider("nvidia")
        provider = FallbackProvider([p1, p2])
        result = provider.chat([MagicMock()])
        assert result.content == "Response from groq"
        p1.chat.assert_called_once()

    def test_fallback_on_rate_limit(self):
        p1 = self._make_provider("groq", succeeds=False, error_category="rate_limit")
        p2 = self._make_provider("nvidia")
        provider = FallbackProvider([p1, p2])
        result = provider.chat([MagicMock()])
        assert result.content == "Response from nvidia"

    def test_auth_error_stops_fallback(self):
        p1 = self._make_provider("groq", succeeds=False, error_category="authentication")
        p2 = self._make_provider("nvidia")
        provider = FallbackProvider([p1, p2])
        with pytest.raises(ProviderError) as exc_info:
            provider.chat([MagicMock()])
        assert exc_info.value.category == "authentication"
        p2.chat.assert_not_called()

    def test_all_fail_raises_aggregate(self):
        p1 = self._make_provider("groq", succeeds=False, error_category="timeout")
        p2 = self._make_provider("nvidia", succeeds=False, error_category="server_error")
        provider = FallbackProvider([p1, p2])
        with pytest.raises(ProviderError) as exc_info:
            provider.chat([MagicMock()])
        # The aggregate error should mention both providers
        assert "groq" in exc_info.value.message.lower() or "Groq" in exc_info.value.message
        assert "nvidia" in exc_info.value.message.lower() or "NVIDIA" in exc_info.value.message

    def test_requires_two_providers(self):
        p1 = self._make_provider("groq")
        with pytest.raises(ValueError):
            FallbackProvider([p1])

    def test_set_model_propagates(self):
        p1 = self._make_provider("groq")
        p2 = self._make_provider("nvidia")
        provider = FallbackProvider([p1, p2])
        provider.set_model("llama-3.3-70b-versatile")
        p1.set_model.assert_called_once_with("llama-3.3-70b-versatile")
        p2.set_model.assert_called_once_with("llama-3.3-70b-versatile")

    def test_last_served_tracking(self):
        p1 = self._make_provider("groq")
        p2 = self._make_provider("nvidia", succeeds=False, error_category="rate_limit")
        provider = FallbackProvider([p1, p2])
        provider.chat([MagicMock()])
        assert provider.last_served is p1


# ─── 7. Integration: Compaction + Steering in Agent Loop ──────────────────


class TestAgentLoopIntegration:
    def test_steering_queue_initialization(self):
        ctx = {
            "tools": [],
            "provider": MagicMock(),
            "session": MagicMock(),
            "project": MagicMock(),
            "projectRoot": "/tmp",
            "signal": AbortSignal(),
        }
        loop = AgentLoop(ctx)
        assert isinstance(loop.steering, SteeringQueue)
        assert not loop.steering.has_pending

    def test_steering_queue_from_context(self):
        custom_queue = SteeringQueue()
        custom_queue.push("test message")
        ctx = {
            "tools": [],
            "provider": MagicMock(),
            "session": MagicMock(),
            "project": MagicMock(),
            "projectRoot": "/tmp",
            "signal": AbortSignal(),
            "steering": custom_queue,
        }
        loop = AgentLoop(ctx)
        assert loop.steering is custom_queue
        assert loop.steering.has_pending


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
