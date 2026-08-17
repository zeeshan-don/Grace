"""TUI store (port of src/cli/tui/store.ts).

A single mutable state object + subscriber list. Every mutation bumps
`version` and notifies. All interactive logic (input editing, history,
scrolling, overlays) lives here so it is pure, unit-testable and independent
of the renderer.
"""

import threading
import time

from grace.cli.tui.commands import HOME_SHORTCUTS, SLASH_COMMANDS

MAX_ACTIVITY = 2_000

# NOTE: keep the counter under a DIFFERENT name than the function — the
# `def` would otherwise shadow the list, making every call raise
# "'function' object is not subscriptable" (TS→Python migration trap).
_id_counter = [1]


def _next_id() -> int:
    _id_counter[0] += 1
    return _id_counter[0]


class TuiStore:
    def __init__(self, info: dict) -> None:
        self.info = info
        self.listeners: set = set()
        self.version_value = 0

        # -- layout / mode -------------------------------------------------
        self.mode = "home"  # 'home' | 'session'
        self.focus = "input"
        self.shortcut_index = 0

        # -- input ---------------------------------------------------------
        self.input = ""
        self.cursor = 0
        self.history: list[str] = []
        self.history_index = -1

        # -- activity ------------------------------------------------------
        self.items: list[dict] = []
        self.busy = False
        self.scroll = 0
        self.changed_files: list[str] = []
        self._tool_calls = 0

        # -- overlays ------------------------------------------------------
        self.permission: dict | None = None
        self.picker: dict | None = None
        self.palette: dict | None = None
        self.help_open = False
        self.login: dict | None = None

        self.task_started_at: float | None = None

    # ---------------------------------------------------------------------
    # Subscription
    # ---------------------------------------------------------------------

    def get_version(self) -> int:
        return self.version_value

    def subscribe(self, listener) -> callable:
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    def notify(self) -> None:
        self.version_value += 1
        for l in list(self.listeners):
            l()

    def refresh(self) -> None:
        self.notify()

    # ---------------------------------------------------------------------
    # Input editing
    # ---------------------------------------------------------------------

    def insert(self, ch: str) -> None:
        if not ch:
            return
        self.input = self.input[:self.cursor] + ch + self.input[self.cursor:]
        self.cursor += len(ch)
        self.sync_palette()
        self.notify()

    def backspace(self) -> None:
        if self.cursor == 0:
            return
        self.input = self.input[:self.cursor - 1] + self.input[self.cursor:]
        self.cursor -= 1
        self.sync_palette()
        self.notify()

    def delete(self) -> None:
        if self.cursor >= len(self.input):
            return
        self.input = self.input[:self.cursor] + self.input[self.cursor + 1:]
        self.sync_palette()
        self.notify()

    def move_left(self) -> None:
        if self.cursor > 0:
            self.cursor -= 1
            self.notify()

    def move_right(self) -> None:
        if self.cursor < len(self.input):
            self.cursor += 1
            self.notify()

    def home(self) -> None:
        if self.cursor != 0:
            self.cursor = 0
            self.notify()

    def end(self) -> None:
        if self.cursor != len(self.input):
            self.cursor = len(self.input)
            self.notify()

    def clear_input(self) -> None:
        if self.input == "" and self.palette is None:
            return
        self.input = ""
        self.cursor = 0
        self.close_palette()
        self.history_index = -1
        self.notify()

    def set_input(self, text: str) -> None:
        self.input = text
        self.cursor = len(text)
        self.history_index = -1
        self.sync_palette()
        self.notify()

    def submit_input(self) -> None:
        text = self.input.strip()
        if text:
            if not self.history or self.history[-1] != text:
                self.history.append(text)
            if len(self.history) > 200:
                self.history = self.history[-200:]
        self.history_index = -1
        self.input = ""
        self.cursor = 0
        self.focus = "input"
        self.close_palette()
        self.notify()

    def history_up(self) -> None:
        if not self.history:
            return
        if self.history_index == -1:
            self.history_index = len(self.history) - 1
        elif self.history_index > 0:
            self.history_index -= 1
        else:
            return
        self.input = self.history[self.history_index] or ""
        self.cursor = len(self.input)
        self.sync_palette()
        self.notify()

    def history_down(self) -> None:
        if self.history_index == -1:
            return
        self.history_index += 1
        if self.history_index >= len(self.history):
            self.history_index = -1
            self.input = ""
        else:
            self.input = self.history[self.history_index] or ""
        self.cursor = len(self.input)
        self.sync_palette()
        self.notify()

    # ---------------------------------------------------------------------
    # Activity feed + scrolling
    # ---------------------------------------------------------------------

    def push(self, kind: str, text: str) -> None:
        if not text:
            return
        lines = text.split("\n")
        for raw in lines:
            line = raw.replace("\r", "").rstrip()
            if line == "":
                continue
            self.items.append({"id": _next_id(), "kind": kind, "text": line})
        if len(self.items) > MAX_ACTIVITY:
            self.items = self.items[-MAX_ACTIVITY:]
        self.notify()

    def clear_activity(self) -> None:
        self.items = []
        self.scroll = 0
        self.changed_files = []
        self._tool_calls = 0
        self.mode = "home"
        self.notify()

    def scroll_up(self, lines: int) -> None:
        max_scroll = len(self.items) - 1
        if max_scroll <= 0:
            return
        self.scroll = min(max_scroll, self.scroll + lines)
        self.notify()

    def scroll_down(self, lines: int) -> None:
        self.scroll = max(0, self.scroll - lines)
        self.notify()

    def scroll_to_bottom(self) -> None:
        if self.scroll != 0:
            self.scroll = 0
            self.notify()

    def toggle_focus(self) -> None:
        if self.mode == "home":
            self.focus = "shortcuts" if self.focus == "input" else "input"
        else:
            self.focus = "activity" if self.focus == "input" else "input"
        self.notify()

    def set_focus(self, focus: str) -> None:
        if self.focus != focus:
            self.focus = focus
            self.notify()

    def shortcut_move(self, delta: int) -> None:
        if not HOME_SHORTCUTS:
            return
        self.shortcut_index = (self.shortcut_index + delta + len(HOME_SHORTCUTS)) % len(HOME_SHORTCUTS)
        self.notify()

    # ---------------------------------------------------------------------
    # Task lifecycle
    # ---------------------------------------------------------------------

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.task_started_at = time.monotonic() if busy else None
        self.notify()

    def record_tool_call(self) -> None:
        self._tool_calls += 1

    @property
    def tool_call_count(self) -> int:
        return self._tool_calls

    def record_changed_file(self, path: str) -> None:
        if path not in self.changed_files:
            self.changed_files.append(path)

    # ---------------------------------------------------------------------
    # Permission dialog
    # ---------------------------------------------------------------------

    def ask_permission(self, command: str, reasons: list[str]) -> bool:
        """Open the permission dialog; blocks (in the worker thread) until the
        user answers y/n/a."""
        holder: dict = {"result": False, "done": threading.Event()}
        self.permission = {"id": _next_id(), "command": command, "reasons": reasons, "holder": holder}
        self.notify()
        holder["done"].wait()
        return holder["result"]

    def answer_permission(self, allowed: bool) -> None:
        p = self.permission
        if not p:
            return
        self.permission = None
        p["holder"]["result"] = allowed
        p["holder"]["done"].set()
        self.notify()

    # ---------------------------------------------------------------------
    # Pickers (model / provider)
    # ---------------------------------------------------------------------

    def open_picker(self, kind: str, title: str, options: list[dict], on_select, on_cancel=None) -> None:
        current = 0
        for i, o in enumerate(options):
            if o.get("current"):
                current = i
                break
        self.picker = {
            "id": _next_id(),
            "kind": kind,
            "title": title,
            "options": list(options),
            "all": list(options),
            "filter": "",
            "selected": max(0, current),
            "onSelect": on_select,
            "onCancel": on_cancel or (lambda: None),
        }
        self.notify()

    def picker_filter(self, query: str) -> None:
        p = self.picker
        if not p:
            return
        p["filter"] = query
        p["options"] = [o for o in p["all"] if query.lower() in o.get("label", "").lower()]
        if p["selected"] >= len(p["options"]):
            p["selected"] = max(0, len(p["options"]) - 1)
        self.notify()

    def picker_move(self, delta: int) -> None:
        p = self.picker
        if not p or not p["options"]:
            return
        p["selected"] = (p["selected"] + delta + len(p["options"])) % len(p["options"])
        self.notify()

    def picker_select(self) -> None:
        p = self.picker
        if not p:
            return
        opts = p["options"]
        if p["selected"] >= len(opts):
            return
        opt = opts[p["selected"]]
        if opt.get("disabled"):
            return
        index = p["selected"]
        on_select = p["onSelect"]
        self.picker = None
        on_select(opt, index)

    def close_picker(self) -> None:
        p = self.picker
        self.picker = None
        if p and p.get("onCancel"):
            p["onCancel"]()
        self.notify()

    # ---------------------------------------------------------------------
    # Command palette
    # ---------------------------------------------------------------------

    def sync_palette(self) -> None:
        if self.input.startswith("/") and len(self.input) >= 1:
            if not self.palette:
                self.palette = {"commands": list(SLASH_COMMANDS), "query": "", "selected": 0}
                self.notify()
            self.palette["query"] = self.input
        else:
            self.close_palette()

    def set_palette_commands(self, commands: list[dict]) -> None:
        if not self.palette:
            return
        self.palette["commands"] = commands
        self.notify()

    def palette_move(self, delta: int) -> None:
        p = self.palette
        if not p or not p["commands"]:
            return
        p["selected"] = (p["selected"] + delta + len(p["commands"])) % len(p["commands"])
        self.notify()

    def palette_rows(self) -> list[dict]:
        """Visible palette rows for the current query. Matches on the FIRST
        token so "/model groq" still highlights /model while keeping typed args
        intact."""
        if not self.palette:
            return []
        raw = self.palette["query"][1:] if self.palette["query"].startswith("/") else self.palette["query"]
        query = (raw.split()[0] if raw.split() else "").lower()
        rows = [c for c in self.palette["commands"] if c["name"].lower().startswith("/" + query)] if query else self.palette["commands"]
        return rows[:10]

    def close_palette(self) -> None:
        if self.palette:
            self.palette = None
            self.notify()

    # ---------------------------------------------------------------------
    # Help overlay
    # ---------------------------------------------------------------------

    def open_help(self) -> None:
        self.help_open = True
        self.notify()

    def close_help(self) -> None:
        self.help_open = False
        self.notify()

    # ---------------------------------------------------------------------
    # Login/register overlay
    # ---------------------------------------------------------------------

    def open_login(self, purpose: str, email_arg: str) -> None:
        self.login = {"purpose": purpose, "email": (email_arg or "").strip(), "field": "email", "password": "", "confirm": "", "busy": False}
        self.notify()

    def login_type(self, ch: str) -> None:
        l = self.login
        if not l or l.get("busy"):
            return
        field = l["field"]
        if field == "email":
            l["email"] += ch
        elif field == "password":
            l["password"] += ch
        else:
            l["confirm"] += ch
        self.notify()

    def login_backspace(self) -> None:
        l = self.login
        if not l or l.get("busy"):
            return
        field = l["field"]
        if field == "email":
            l["email"] = l["email"][:-1]
        elif field == "password":
            l["password"] = l["password"][:-1]
        else:
            l["confirm"] = l["confirm"][:-1]
        self.notify()

    def login_next_field(self) -> None:
        l = self.login
        if not l or l.get("busy"):
            return
        if l["field"] == "email":
            l["field"] = "password"
        elif l["field"] == "password":
            l["field"] = "confirm" if l["purpose"] == "register" else "email"
        else:
            l["field"] = "email"
        self.notify()

    def login_set_field(self, field: str) -> None:
        l = self.login
        if not l:
            return
        l["field"] = field
        self.notify()

    def login_error(self, error: str) -> None:
        l = self.login
        if not l:
            return
        l["error"] = error
        l["busy"] = False
        self.notify()

    def login_busy(self) -> None:
        l = self.login
        if not l:
            return
        l["busy"] = True
        l.pop("error", None)
        self.notify()

    def close_login(self) -> None:
        self.login = None
        self.notify()
