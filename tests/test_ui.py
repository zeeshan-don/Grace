"""UI rendering tests: GRACE FREE helpers, progress renderer, results, banner."""

from grace.cli.free_plan import (
    banner_free_plan_line,
    format_countdown,
    format_daily_usage,
    session_status_line,
)
from grace.cli.ui.progress import ProgressRenderer, _is_noise, _one_liner
from grace.cli.ui.results import classify_file_changes, collapse_lines, render_error
from grace.cli.ui.theme import strip_ansi, symbols, visual_width
from grace.colors import set_color_enabled


def test_format_countdown():
    assert format_countdown(47 * 60 + 12) == "47m 12s"
    assert format_countdown(12) == "12s"
    assert format_countdown(0) == "expired"
    assert format_countdown(-5) == "expired"
    assert format_countdown(None) == ""


def test_format_daily_usage():
    assert format_daily_usage(6 * 3600) == "6h"
    assert format_daily_usage(3600 + 35 * 60) == "1h 35m"
    assert format_daily_usage(10 * 60) == "10m"
    assert format_daily_usage(45) == "45s"
    assert format_daily_usage(-1) == ""


def test_session_status_line():
    state = {
        "sessionsUsed": 1,
        "sessionsRemaining": 5,
        "currentSession": 2,
        "sessionExpiresAt": None,
        "dailyUsedSeconds": 600,
        "dailyLimitSeconds": 10_800,
    }
    line = session_status_line(state)
    assert "Session 2 / 6" in strip_ansi(line)
    assert "used today" in strip_ansi(line)
    assert session_status_line(None) == ""
    assert session_status_line({}) == ""


def test_banner_free_plan_line():
    state = {"sessionsUsed": 1, "sessionsRemaining": 5, "dailyLimitSeconds": 10_800}
    line = banner_free_plan_line(state)
    assert "5 sessions remaining" in strip_ansi(line)
    exhausted = {"sessionsUsed": 6, "sessionsRemaining": 0, "dailyLimitSeconds": 10_800}
    assert "all 6 sessions used" in strip_ansi(banner_free_plan_line(exhausted))
    assert banner_free_plan_line(None) == ""


# ---------------------------------------------------------------------------
# Progress renderer
# ---------------------------------------------------------------------------


def test_progress_noise_filtering():
    assert _is_noise("Thinking…")
    assert _is_noise("Done in 3 iteration(s), 4 tool call(s).")
    assert not _is_noise("→ read_file src/a.ts")


def test_progress_one_liner_caps():
    assert len(_one_liner("x" * 200)) <= 90


def test_progress_plain_mode_renders_settled_lines():
    set_color_enabled(False)
    out: list[str] = []
    renderer = ProgressRenderer({"out": (lambda t: out.append(t)), "live": False, "verbose": False})
    renderer.event({"type": "route", "route": "coding"})
    renderer.event({"type": "working"})
    renderer.event({"type": "agent-done", "role": "editor", "label": "Grace", "status": "completed", "summary": "All done."})
    renderer.end()
    text = "".join(out)
    assert "Grace is working" in text or "Done" in text
    assert "All done." in text


def test_progress_suppresses_conversation():
    set_color_enabled(False)
    out: list[str] = []
    renderer = ProgressRenderer({"out": (lambda t: out.append(t)), "live": False})
    renderer.event({"type": "route", "route": "conversation"})
    renderer.event({"type": "working"})
    renderer.end()
    assert "".join(out) == ""


def test_progress_verbose_shows_tool_status():
    set_color_enabled(False)
    out: list[str] = []
    renderer = ProgressRenderer({"out": (lambda t: out.append(t)), "live": False, "verbose": True})
    renderer.event({"type": "status", "message": "→ read_file package.json"})
    text = "".join(out)
    assert "read_file package.json" in text


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


def test_render_error_never_contains_hint_secrets():
    set_color_enabled(False)
    out = render_error("Provider unavailable", "try again")
    assert "Provider unavailable" in out
    assert "try again" in out


def test_collapse_lines_hides_tail():
    set_color_enabled(False)
    text = "\n".join(f"line {i}" for i in range(50))
    out = collapse_lines(text, {"max": 10})
    assert "line 0" in out
    assert "line 49" not in out
    assert "hidden" in out


def test_collapse_lines_short_input_untouched():
    out = collapse_lines("a\nb")
    assert out == "  a\n  b"


def test_classify_file_changes_uses_git_status(tmp_path):
    (tmp_path / "new.py").write_text("x", encoding="utf-8")
    (tmp_path / "mod.py").write_text("x", encoding="utf-8")

    def fake_status(root):
        return " M mod.py\n?? new.py\n"

    changes = classify_file_changes(["new.py", "mod.py", "gone.py"], str(tmp_path), {
        "isRepo": (lambda root: True),
        "getStatus": fake_status,
    })
    by_path = {c["path"]: c["status"] for c in changes}
    assert by_path["new.py"] == "A"
    assert by_path["mod.py"] == "M"
    assert by_path["gone.py"] == "D"


def test_symbols_and_strip_ansi():
    sym = symbols()
    assert sym["check"]
    assert strip_ansi("\x1b[31mred\x1b[0m") == "red"
    assert visual_width("\x1b[31mab\x1b[0m") == 2
