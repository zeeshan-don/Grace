"""Tool tests: read/write/edit/search/list + run_command policy."""

import json

from grace.tools.edit_file import create_edit_file_tool
from grace.tools.list_directory import create_list_directory_tool
from grace.tools.read_file import create_read_file_tool
from grace.tools.run_command import create_run_command_tool, matches_prefix
from grace.tools.search_files import create_search_files_tool
from grace.tools.tool import ToolContext
from grace.tools.write_file import create_write_file_tool


def _ctx(root, ask=None):
    return ToolContext(projectRoot=root, askPermission=ask or (lambda cmd, reasons: True))


def test_write_and_read_roundtrip(tmp_path):
    ctx = _ctx(str(tmp_path))
    write = create_write_file_tool(ctx)
    read = create_read_file_tool(ctx)

    out = write.execute({"path": "hello.py", "content": "print('hi')\n"}, ctx)
    assert (tmp_path / "hello.py").read_text(encoding="utf-8") == "print('hi')\n"

    content = read.execute({"path": "hello.py"}, ctx)
    assert "print('hi')" in content


def test_read_blocks_escapes(tmp_path):
    ctx = _ctx(str(tmp_path))
    read = create_read_file_tool(ctx)
    out = read.execute({"path": "../outside.txt"}, ctx)
    assert "Error" in out or "escapes" in out


def test_read_blocks_protected(tmp_path):
    ctx = _ctx(str(tmp_path))
    (tmp_path / ".env").write_text("SECRET=1", encoding="utf-8")
    read = create_read_file_tool(ctx)
    out = read.execute({"path": ".env"}, ctx)
    assert "Error" in out or "protected" in out or "refused" in out


def test_edit_file_replaces_exact(tmp_path):
    ctx = _ctx(str(tmp_path))
    target = tmp_path / "a.txt"
    target.write_text("line one\nline two\n", encoding="utf-8")
    edit = create_edit_file_tool(ctx)
    out = edit.execute({
        "path": "a.txt",
        "edits": [{"oldString": "line one", "newString": "line ONE"}],
    }, ctx)
    assert "line ONE\nline two" in target.read_text(encoding="utf-8")


def test_edit_file_reports_missing_pattern(tmp_path):
    ctx = _ctx(str(tmp_path))
    target = tmp_path / "a.txt"
    target.write_text("hello", encoding="utf-8")
    edit = create_edit_file_tool(ctx)
    out = edit.execute({"path": "a.txt", "edits": [{"oldString": "nope", "newString": "x"}]}, ctx)
    assert "Error" in out or "not found" in out


def test_search_files_finds_hits(tmp_path):
    ctx = _ctx(str(tmp_path))
    (tmp_path / "app.py").write_text("def calculate(x):\n    return x\n", encoding="utf-8")
    search = create_search_files_tool(ctx)
    out = search.execute({"query": "calculate"}, ctx)
    assert "app.py" in out


def test_list_directory_shows_entries(tmp_path):
    ctx = _ctx(str(tmp_path))
    (tmp_path / "a.py").write_text("", encoding="utf-8")
    (tmp_path / "b.py").write_text("", encoding="utf-8")
    lst = create_list_directory_tool(ctx)
    out = lst.execute({}, ctx)
    assert "a.py" in out and "b.py" in out


def test_run_command_requires_approval_for_dangerous(tmp_path):
    denied = {"asked": []}

    def ask(cmd, reasons):
        denied["asked"].append(cmd)
        return False

    ctx = _ctx(str(tmp_path), ask)
    run = create_run_command_tool(ctx)
    out = run.execute({"command": "rm -rf node_modules"}, ctx)
    assert "denied" in out.lower() or "blocked" in out.lower()
    assert len(denied["asked"]) == 1


def test_run_command_approved_prefixes_skip_prompt(tmp_path):
    from grace.agents.capabilities import TEST_PREFIXES

    ctx = _ctx(str(tmp_path), lambda cmd, reasons: (_ for _ in ()).throw(AssertionError("must not ask")))
    ctx.commandPolicy = {"allowPrefixes": TEST_PREFIXES}
    run = create_run_command_tool(ctx)
    out = run.execute({"command": "npm test"}, ctx)
    assert isinstance(out, str)


def test_matches_prefix_word_boundary():
    assert matches_prefix("npm test", ["npm test"])
    assert matches_prefix("npm test --watch", ["npm test"])
    assert not matches_prefix("npm tests", ["npm test"])
    assert matches_prefix("pytest tests/", ["pytest"])
