"""Auth session persistence + local conversation session tests."""

import json
import stat
from datetime import datetime, timedelta, timezone

from grace.auth.session import clear_session, load_session, save_session, session_expired
from grace.session.session import Session
from grace.session.undo import UndoStore


def test_save_and_load_session_roundtrip(tmp_path):
    path = str(tmp_path / "auth.json")
    session = {
        "apiUrl": "https://zeesh-ai.vercel.app",
        "token": "tok-123",
        "user": {"id": "u1", "email": "a@b.com", "displayName": "Zeeshan"},
        "expiresAt": "2099-01-01T00:00:00Z",
        "createdAt": "2026-01-01T00:00:00Z",
    }
    save_session(session, path)
    loaded = load_session(path)
    assert loaded is not None
    assert loaded["token"] == "tok-123"
    assert loaded["user"]["email"] == "a@b.com"
    assert loaded["apiUrl"] == "https://zeesh-ai.vercel.app"


def test_session_expired():
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert not session_expired({"expiresAt": future})
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert session_expired({"expiresAt": past})
    assert session_expired({"expiresAt": "not-a-date"})


def test_clear_session(tmp_path):
    path = str(tmp_path / "auth.json")
    save_session({"apiUrl": "x", "token": "t", "user": {"id": "u", "email": "e"}, "expiresAt": ""}, path)
    assert load_session(path) is not None
    clear_session(path)
    assert load_session(path) is None


def test_load_session_corrupt_returns_none(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text("not json", encoding="utf-8")
    assert load_session(str(path)) is None


def test_auth_file_permissions_restrictive(tmp_path):
    import os

    if os.name == "nt":
        return  # Windows does not enforce POSIX modes
    path = str(tmp_path / "auth.json")
    save_session({"apiUrl": "x", "token": "t", "user": {"id": "u", "email": "e"}, "expiresAt": ""}, path)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode & 0o077 == 0, "session file must not be group/other readable"


# ---------------------------------------------------------------------------
# Conversation session (.zeesh/session.json)
# ---------------------------------------------------------------------------


def test_session_persists_messages(tmp_path):
    root = str(tmp_path)
    s = Session(root)
    s.push_message({"role": "user", "content": "hello"})
    s.record_tool_call("read_file x")
    s.save()

    s2 = Session(root)  # fresh load from disk
    assert len(s2.messages) == 1
    assert s2.messages[0]["content"] == "hello"
    assert s2.stats["toolCalls"] == 1


def test_session_clear(tmp_path):
    root = str(tmp_path)
    s = Session(root)
    s.push_message({"role": "user", "content": "x"})
    s.save()
    s.clear()
    assert s.message_count == 0
    assert load_session2(root)["messages"] == []


def load_session2(root):
    import json

    from pathlib import Path

    return json.loads(Path(root, ".zeesh", "session.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Undo store
# ---------------------------------------------------------------------------


def test_undo_restores_modified_file(tmp_path):
    root = str(tmp_path)
    target = tmp_path / "a.txt"
    target.write_text("before", encoding="utf-8")
    undo = UndoStore(root)
    assert undo.record(str(target), "before") is True
    target.write_text("after", encoding="utf-8")

    result = undo.undo()
    assert result is not None
    assert result["file"] == str(target)
    assert result["hadPrevious"] is True
    assert target.read_text(encoding="utf-8") == "before"


def test_undo_removes_created_file(tmp_path):
    root = str(tmp_path)
    target = tmp_path / "new.py"
    target.write_text("x", encoding="utf-8")
    undo = UndoStore(root)
    undo.record(str(target), None)
    result = undo.undo()
    assert result is not None
    assert result["hadPrevious"] is False
    assert not target.exists()


def test_undo_nothing_when_empty(tmp_path):
    undo = UndoStore(str(tmp_path))
    assert undo.undo() is None


def test_pending_changes_lists_agent_edits(tmp_path):
    root = str(tmp_path)
    undo = UndoStore(root)
    undo.record(str(tmp_path / "a.txt"), "old")
    undo.record(str(tmp_path / "new.py"), None)
    pending = undo.pending_changes()
    assert any("a.txt" in p for p in pending)
    assert any("new.py" in p for p in pending)
