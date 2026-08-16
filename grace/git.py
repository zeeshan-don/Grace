"""Git helpers (port of src/git/git.ts)."""

import os
import subprocess


def run_git(root: str, args: list[str]) -> dict:
    try:
        res = subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return {"ok": res.returncode == 0, "stdout": res.stdout or "", "stderr": res.stderr or "", "code": res.returncode}
    except Exception:
        return {"ok": False, "stdout": "", "stderr": "", "code": None}


def is_git_repo(root: str) -> bool:
    if os.path.exists(os.path.join(root, ".git")):
        return True
    res = run_git(root, ["rev-parse", "--is-inside-work-tree"])
    return res["ok"] and res["stdout"].strip() == "true"


def current_branch(root: str) -> str | None:
    res = run_git(root, ["branch", "--show-current"])
    if res["ok"] and res["stdout"].strip():
        return res["stdout"].strip()
    return None


def status_short(root: str) -> str:
    res = run_git(root, ["status", "--short"])
    if res["ok"]:
        return res["stdout"].rstrip()
    return f"(git unavailable: {res['stderr'].strip()})"


def diff_stat(root: str) -> str:
    res = run_git(root, ["diff", "--stat"])
    return res["stdout"].rstrip() if res["ok"] else ""


def diff_unified(root: str, max_lines: int = 300) -> str:
    res = run_git(root, ["diff"])
    if not res["ok"]:
        return ""
    lines = res["stdout"].split("\n")
    if len(lines) <= max_lines:
        return res["stdout"]
    return "\n".join(lines[:max_lines]) + f"\n… [diff truncated, {len(lines) - max_lines} more lines]"


def recent_log(root: str, n: int = 5) -> str:
    res = run_git(root, ["log", f"-{n}", "--oneline", "--no-decorate"])
    return res["stdout"].rstrip() if res["ok"] else ""


def git_awareness(root: str) -> str:
    """Compact git context injected into the agent's system prompt."""
    g = git_summary(root)
    if not g["isRepo"]:
        return "(not a git repository)"
    parts = [f"branch: {g['branch'] or 'detached'}", f"working tree: {g['statusLines']} change(s)" if g["hasChanges"] else "working tree: clean"]
    status = status_short(root)
    if status.strip():
        parts.append("status:\n" + "\n".join(status.split("\n")[:15]))
    recent = recent_log(root, 3)
    if recent.strip():
        parts.append("recent commits:\n" + recent)
    return "\n".join(parts)


def git_summary(root: str) -> dict:
    repo = is_git_repo(root)
    if not repo:
        return {"branch": None, "statusLines": 0, "hasChanges": False, "isRepo": False}
    short = status_short(root)
    status_lines = len([l for l in short.split("\n") if l.strip()])
    return {"branch": current_branch(root), "statusLines": status_lines, "hasChanges": status_lines > 0, "isRepo": True}
