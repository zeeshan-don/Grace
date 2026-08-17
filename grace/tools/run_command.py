"""run_command tool (port of src/tools/runCommand.ts)."""

import os
import re
import subprocess

from grace.safety import assess_command, redact_secrets
from grace.tools.tool import Tool
from grace.util_text import truncate_middle

DEFAULT_TIMEOUT_SEC = 120
# Hard cap on a single command's runtime — a hung server must never stall the agent.
MAX_TIMEOUT_SEC = 300
MAX_OUTPUT_CHARS = 100_000


def matches_prefix(command: str, prefixes) -> bool:
    """True when `command` starts with any of the prefixes (word-boundary aware)."""
    if not prefixes:
        return False
    cmd = command.strip()
    for p in prefixes:
        prefix = p.strip()
        if not prefix:
            continue
        # Prefix match must not be a partial word: "npm test" must not match "npm tests".
        rest = cmd[len(prefix):]
        if cmd.startswith(prefix) and (rest == "" or re.match(r"^\s|^[|&;]", rest)):
            return True
    return False


def run_shell_command(command: str, cwd: str, timeout_sec: int = DEFAULT_TIMEOUT_SEC, shell: str | None = None) -> dict:
    """Run a command; returns {stdout, stderr, exitCode, timedOut}."""
    try:
        res = subprocess.run(
            command,
            cwd=cwd,
            shell=True,
            executable=shell,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
        )
        return {"stdout": res.stdout or "", "stderr": res.stderr or "", "exitCode": res.returncode, "timedOut": False}
    except subprocess.TimeoutExpired as err:
        timed_out = True
        exit_code = None
        # Best-effort kill of the process tree on Windows (grandchildren may linger).
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/pid", str(err.pid), "/T", "/F"], capture_output=True, timeout=10)
            except Exception:
                pass
        return {
            "stdout": (err.stdout or b"").decode("utf-8", errors="replace") if isinstance(err.stdout, bytes) else (err.stdout or ""),
            "stderr": (err.stderr or b"").decode("utf-8", errors="replace") if isinstance(err.stderr, bytes) else (err.stderr or ""),
            "exitCode": exit_code,
            "timedOut": timed_out,
        }
    except Exception as err:
        return {"stdout": "", "stderr": str(err), "exitCode": None, "timedOut": False}


def shell_for_platform() -> str | None:
    custom = os.environ.get("ZEESH_SHELL")
    if custom:
        return custom
    if os.name == "nt":
        return os.environ.get("ComSpec") or "cmd.exe"
    return os.environ.get("SHELL") or "/bin/sh"


def _resolve_cwd(project_root: str, raw: str) -> str:
    if raw == ".":
        return project_root
    if os.path.isabs(raw):
        return raw
    return os.path.join(project_root, raw)


def create_run_command_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        command = args.get("command") if isinstance(args.get("command"), str) else ""
        command = command.strip()
        if not command:
            return 'Error: "command" is required.'

        cwd_raw = args.get("cwd") if isinstance(args.get("cwd"), str) and args.get("cwd") else "."
        cwd = _resolve_cwd(ctx.projectRoot, cwd_raw)
        if isinstance(args.get("timeoutSec"), (int, float)) and args.get("timeoutSec") > 0:
            requested = int(args.get("timeoutSec"))
        else:
            requested = DEFAULT_TIMEOUT_SEC
        # A long-running server command must never hang the agent for hours.
        timeout_sec = min(requested, MAX_TIMEOUT_SEC)

        assessment = assess_command(command)

        # Policy tier 1: explicitly approved prefixes never ask (test commands etc.).
        policy = getattr(ctx, "commandPolicy", None)
        if not matches_prefix(command, (policy or {}).get("allowPrefixes") if policy else None):
            # Policy tier 2: some roles must always confirm mutating operations.
            must_ask = matches_prefix(command, (policy or {}).get("requireApprovalPrefixes") if policy else None)
            if assessment.level == "flagged" or must_ask:
                reasons = list(assessment.reasons) + (["requires explicit approval for this agent role"] if must_ask else [])
                allowed = ctx.askPermission(command, reasons)
                if not allowed:
                    return f"Command blocked: user denied permission.\nCommand: {command}\nReason: {'; '.join(reasons)}"

        if ctx.onTool:
            ctx.onTool("run_command", {"command": command, "cwd": cwd})
        result = run_shell_command(command, cwd, timeout_sec=timeout_sec, shell=shell_for_platform())

        stdout = truncate_middle(redact_secrets(result["stdout"]), MAX_OUTPUT_CHARS)
        stderr = truncate_middle(redact_secrets(result["stderr"]), MAX_OUTPUT_CHARS)
        exit_line = f"(timed out after {timeout_sec}s — killed)" if result["timedOut"] else f"(exit code {result['exitCode'] if result['exitCode'] is not None else 'unknown'})"

        parts: list[str] = []
        if stdout.strip():
            parts.append(f"STDOUT:\n{stdout}")
        if stderr.strip():
            parts.append(f"STDERR:\n{stderr}")
        if result["exitCode"] != 0:
            parts.append(f"Command failed {exit_line}. Read the error output and fix the issue, then re-run.")
        else:
            parts.append(f"Command succeeded {exit_line}.")
        return "\n\n".join(parts)

    return Tool(
        name="run_command",
        description="Run a terminal command; returns stdout/stderr/exit code. Destructive commands require user approval.",
        parameters={
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command. Do not start long-running servers/processes; use a short, bounded check instead."},
                "cwd": {"type": "string", "description": "Workdir relative to root (default root)."},
                "timeoutSec": {"type": "number", "description": "Timeout in seconds (capped at 300). Default 120."},
            },
            "required": ["command"],
        },
        execute=execute,
    )
