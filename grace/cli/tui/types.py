"""TUI state types (port of src/cli/tui/types.ts).

The TUI is a presentation layer over the existing agent system: the store is
the single source of truth for everything the interface renders, and every
value comes from real runtime state (workspace, provider, model, session,
live agent events). No fake numbers, no decorative state.
"""

# What a single activity line represents (drives its color).
ACTIVITY_KINDS = (
    "user", "system", "progress", "tool", "file", "success", "error", "info", "result", "console",
)

# Focus target — Tab cycles: input → shortcuts (home) / activity (session).
FOCUS_TARGETS = ("input", "shortcuts", "activity")


def default_activity_item(id_: int, kind: str, text: str) -> dict:
    return {"id": id_, "kind": kind, "text": text}


def default_tui_info(version: str, workspace: str) -> dict:
    return {
        "version": version,
        "workspace": workspace,
        "provider": "",
        "providerAvailable": False,
        "model": "",
        "session": "Local mode",
    }


def default_permission(id_: int, command: str, reasons: list[str]) -> dict:
    return {"id": id_, "command": command, "reasons": reasons}


def default_picker_option(value: str, label: str) -> dict:
    return {"value": value, "label": label}


def default_slash_command(name: str, usage: str, description: str) -> dict:
    return {"name": name, "usage": usage, "description": description}


def default_login(purpose: str, email_arg: str) -> dict:
    return {"purpose": purpose, "email": (email_arg or "").strip(), "field": "email", "password": "", "confirm": "", "busy": False}
