"""Slash commands (port of src/cli/commands.ts): /help /model /status /diff
/clear /reset /provider /undo."""

import os
import sys

from grace.agents.model_router import pick_model_for_provider
from grace.auth.client import ApiClient
from grace.auth.session import load_session
from grace.cli.banner import render_help
from grace.cli.free_plan import (
    format_countdown,
    format_daily_usage,
    session_seconds_left,
)
from grace.cli.ui.results import (
    collapse_lines,
    output_count_line,
    render_model_panel,
    render_status_panel,
)
from grace.cli.ui.theme import theme
from grace.colors import c
from grace.config import DEFAULT_MODELS, groq_api_key, load_app_config, save_app_config
from grace.git import diff_stat, diff_unified, git_summary, status_short
from grace.providers.registry import create_provider
from grace.providers.remote import RemoteProvider
from grace.util_text import short_path
from grace.verbose import is_verbose


def cmd_help() -> None:
    print(render_help())


def cmd_model(runtime, arg: str) -> None:
    provider = runtime.provider
    if not provider:
        print(render_model_panel({
            "providerAvailable": False,
            "providerLabel": "",
            "model": "",
            "contextWindow": 0,
            "providerError": runtime.provider_error or "No provider configured.",
        }))
        return
    arg_trim = arg.strip()

    if arg_trim == "":
        served = provider.server_provider if isinstance(provider, RemoteProvider) else None
        print(render_model_panel({
            "providerAvailable": True,
            "providerLabel": (served or {}).get("label") or provider.label,
            "servedVia": provider.label if served else None,
            "model": provider.get_model().id,
            "contextWindow": provider.get_model().contextWindow,
        }))
        print(c.dim("Switch with /model <id>. See available ids with /model list."))
        return

    if arg_trim == "list":
        print(c.dim("Fetching models…"))
        models = provider.list_models()
        if not models:
            print(c.yellow("Could not list models for this provider — set one directly with /model <id>."))
            return
        print("\n".join("  " + theme()["model"](m) for m in models))
        print(c.dim(f"\nDefault candidates: {', '.join(DEFAULT_MODELS)}"))
        return

    # Switching model
    try:
        provider.set_model(arg_trim)
    except Exception as err:
        print(c.red(f"Could not switch model: {err}"))
        return
    cfg = load_app_config()
    cfg["provider"] = provider.id
    cfg["model"] = arg_trim
    save_app_config(cfg)
    print(c.green(f"Model set to {arg_trim} (saved)."))


def _session_status_display(status: str) -> str:
    """Render the server's session status label with a state-appropriate color."""
    if status == "active":
        return c.green("active")
    if status == "expired":
        return c.yellow("expired — the next request starts a fresh session")
    if status == "ended":
        return c.yellow("ended — the next request starts a fresh session")
    if status == "none":
        return c.dim("no session yet — the first request starts one")
    if status == "rate_limited":
        return c.red("rate limited by the server")
    if status == "model_unavailable":
        return c.red("model unavailable — the server will fall back")
    if status == "banned":
        return c.red("account disabled")
    if status == "unauthorized":
        return c.red("session invalid — run grace login")
    return c.dim(status)


def _free_plan_status_lines() -> list[str]:
    """GRACE FREE daily session section of /status. Server-authoritative and
    best-effort: offline / pre-session backends just print a dim note."""
    session = load_session()
    if not session:
        return ["  Not logged in — local/offline mode (no session limits)."]
    try:
        api = ApiClient(session["apiUrl"], 3000)
        status = api.get_session_status(session["token"])
        state = status["session"]
        label = _session_status_display(state.get("status"))
        total = state.get("sessionsUsed", 0) + state.get("sessionsRemaining", 0)
        lines = [
            f"  Status:       {label}",
            f"  Sessions:     {state.get('sessionsUsed', 0)} / {total} used today",
            f"  Daily usage:  {format_daily_usage(state.get('dailyUsedSeconds'))} / {format_daily_usage(state.get('dailyLimitSeconds'))}",
        ]
        left = session_seconds_left(state.get("expires_at") or state.get("sessionExpiresAt"))
        lines.append(
            f"  Time left:    {format_countdown(left)} (session {state.get('currentSession') or '—'})"
            if left is not None
            else f"  Time left:    no active session ({state.get('sessionsRemaining', 0)} remaining)"
        )
        if state.get("sessionsRemaining") == 0 and left is None:
            lines.append(f"  {c.yellow('Daily quota reached — new sessions unlock at 00:00 UTC.')}")
        return lines
    except Exception:
        return [f"  {c.dim('Could not reach the backend (offline) — server enforces limits.')}"]


def cmd_status(runtime) -> None:
    p = runtime.project
    git = git_summary(runtime.root)
    provider = runtime.provider
    session = runtime.session

    served = provider.server_provider if isinstance(provider, RemoteProvider) else None
    info = {
        "project": {
            "directory": short_path(runtime.root, os.path.expanduser("~")),
            "type": p.type + (f" · {p.framework}" if p.framework else ""),
            "packageManager": p.packageManager,
            "languages": p.languages,
            "configFiles": p.configFiles,
            "testCommand": p.testCommand,
            "buildCommand": p.buildCommand,
        },
        "git": {
            "isRepo": git["isRepo"],
            "branch": git["branch"],
            "hasChanges": git["hasChanges"],
            "statusLines": git["statusLines"],
        },
        "provider": {
            "available": provider is not None,
            "error": None if provider else (runtime.provider_error or "not configured"),
            "label": (served or {}).get("label") or (provider.label if provider else ""),
            "servedVia": provider.label if served else None,
            "model": provider.get_model().id if provider else "",
            "contextWindow": provider.get_model().contextWindow if provider else 0,
        },
        "session": {
            "messages": session.message_count,
            "toolCalls": session.stats["toolCalls"],
            "runs": session.stats["runs"],
            "inputTokens": session.stats["inputTokens"],
            "outputTokens": session.stats["outputTokens"],
            "undoSnapshots": runtime.undo.count,
        },
        "freePlan": _free_plan_status_lines(),
        "runtime": {
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "stateDir": short_path(os.path.join(runtime.root, ".zeesh"), os.path.expanduser("~")),
        },
    }
    print(render_status_panel(info))


def cmd_diff(runtime) -> None:
    git = git_summary(runtime.root)
    if not git["isRepo"]:
        pending = runtime.undo.pending_changes()
        if not pending:
            print(c.yellow("Not a git repository and no agent changes recorded yet."))
        else:
            print(c.bold("Files changed by the agent (no git repo detected):"))
            print("\n".join("  " + line for line in pending))
        return

    status = status_short(runtime.root)
    if not status or status.strip() == "":
        print(c.green("Working tree clean — no changes to show."))
        return

    status_lines = status.split("\n")
    print(c.bold("git status --short"))
    if len(status_lines) > 40 and not is_verbose():
        print(output_count_line("Command output", len(status_lines)))
    print(collapse_lines(status, {"max": 40, "verbose": is_verbose()}))

    stat = diff_stat(runtime.root)
    if stat.strip():
        print(c.bold("\ngit diff --stat"))
        print("  " + stat.replace("\n", "\n  "))

    diff = diff_unified(runtime.root, 500)
    if diff.strip():
        diff_lines = diff.split("\n")
        print(c.bold("\ngit diff"))
        if len(diff_lines) > 120 and not is_verbose():
            print(output_count_line("Command output", len(diff_lines)))
        print(collapse_lines(diff, {"max": 120, "verbose": is_verbose()}))


def cmd_clear() -> None:
    if sys.stdout.isatty():
        sys.stdout.write("\x1b[2J\x1b[H")
        sys.stdout.flush()


def cmd_reset(runtime) -> None:
    runtime.session.clear()
    print(c.green("Conversation and task context cleared (workspace kept)."))


def cmd_provider(runtime, arg: str) -> None:
    provider = runtime.provider
    arg_trim = arg.strip()

    if arg_trim == "":
        served = provider.server_provider if isinstance(provider, RemoteProvider) else None
        print(render_model_panel({
            "providerAvailable": provider is not None,
            "providerLabel": (served or {}).get("label") or (provider.label if provider else ""),
            "servedVia": provider.label if served else None,
            "model": provider.get_model().id if provider else "",
            "contextWindow": provider.get_model().contextWindow if provider else 0,
            "providerError": runtime.provider_error or "No provider configured.",
        }))
        print("")
        print(c.dim("How the provider is chosen:"))
        print(c.dim("  • A local GROQ_API_KEY uses Groq directly (offline/self-hosted)."))
        print(c.dim("  • Otherwise model calls proxy through the GRACE backend."))
        print(c.dim("  • /provider groq switches to a local Groq provider (key required)."))
        return

    target = arg_trim.lower()
    if target == "groq":
        key = groq_api_key()
        if not key:
            print(c.red("No GROQ_API_KEY configured — add it to ~/.zeesh/env or the project .env first."))
            return
        model = pick_model_for_provider("groq", "coding", runtime.model)
        runtime.provider = create_provider("groq", key, model)
        runtime.model = model
        cfg = load_app_config()
        cfg["provider"] = "groq"
        cfg["model"] = model
        save_app_config(cfg)
        print(c.green(f"Provider set to Groq ({model})."))
        return
    if target in ("nvidia", "deepseek"):
        print(c.yellow(
            f'"{target}" is served server-side only (GRACE backend). A local key for it is not supported on the CLI — '
            "/provider groq uses Groq directly; otherwise /login routes through the backend."
        ))
        return
    print(c.yellow(f'Unknown provider "{arg_trim}". Supported locally: groq — others route through the GRACE backend.'))


def cmd_undo(runtime) -> None:
    result = runtime.undo.undo()
    if not result:
        print(c.yellow("Nothing to undo."))
        return
    print(c.green(f"Reverted {'modifications to' if result['hadPrevious'] else 'creation of'} {result['file']}"))
    print(c.dim("Use /diff to review the working tree."))
