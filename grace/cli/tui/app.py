"""GRACE TUI app — the full-screen agent workspace (Textual).

Renders entirely from the TuiStore (the single source of truth) and follows
the reference UX: a thin header (GRACE + subtle model/session status), a
conversation/activity area that scrolls independently, and a FIXED input bar
at the bottom that never scrolls away. Activity is limited to safe
user-facing summaries — tool lines settle in place (``Reading x`` →
``✓ Read x``), the working state is one small ``● Working`` line, and the
final answer renders as its own block so USER REQUEST → GRACE ACTIVITY →
FINAL ANSWER stay visually distinct. No raw reasoning, tool JSON, or internal
diagnostics are ever rendered.
"""

import time

from textual.app import App
from textual.events import Key
from textual.widgets import Static

from grace.cli.free_plan import format_countdown, session_seconds_left
from grace.cli.tui.commands import HOME_SHORTCUTS, SLASH_COMMANDS
from grace.cli.tui.logo import choose_logo_for, compact_lines, wordmark
from grace.cli.ui.theme import supports_unicode, symbols
from grace.providers.remote import RemoteProvider

TICK_MS = 1.0

# ---------------------------------------------------------------------------
# Palette — dark workspace, restrained color (cyan accent, green success,
# red errors only, gray metadata). The UI is a coding agent, not a dashboard.
# ---------------------------------------------------------------------------
ACCENT = "#22d3ee"     # cyan — Grace identity / in-progress activity
SUCCESS = "#4ade80"    # green — completed activity
ERROR = "#f87171"      # red — errors only
DIM = "#71717a"        # zinc-500 — secondary metadata
FAINT = "#33333a"      # near-black — rules & separators
TEXT = "#d5d5d8"       # body text
USER = "#ececf1"       # user prompts (near-white, bold)

SUBTITLE = "A I   C O D I N G   A G E N T"

SHORTCUT_ICONS = {"/help": "▸", "/status": "◇", "/model": "◈", "/provider": "⚙"}
SHORTCUT_ICONS_ASCII = {"/help": "?", "/status": "=", "/model": "*", "/provider": "#"}

CHROME = 6  # header (2) + input box (3) + footer (1)


def _fit(text: str, width: int) -> str:
    if len(text) <= width:
        return text
    if width <= 1:
        return "…"
    return text[: width - 1] + "…"


def _esc(text: str) -> str:
    """Escape Rich markup so literal ``[text]`` is never parsed as a style
    tag — user input and the ASCII fallback symbols (``[ok]`` / ``[x]``) must
    render as-is on legacy consoles. Only ``[`` needs escaping: Rich renders
    ``\\[`` as a literal bracket, and a lone ``]`` is already literal."""
    return text.replace("[", "\\[")


def _prompt_arrow() -> str:
    """The user-prompt / input arrow degrades to ``>`` on legacy consoles."""
    return "›" if supports_unicode() else ">"


class GraceTuiApp(App):
    """The GRACE full-screen interface. Renders entirely from the TuiStore."""

    BINDINGS: list = []
    CSS = """
    GraceTuiApp {
        background: #0b0d10;
        color: #d5d5d8;
    }
    """

    def __init__(self, store, runner, on_exit) -> None:
        super().__init__()
        self.store = store
        self.runner = runner
        self.on_exit = on_exit
        self._header = Static("", id="header")
        self._body = Static("", id="body")
        self._input = Static("", id="input-line")
        self._footer = Static("", id="footer")
        self._exit_armed_at: float | None = None

    # ---------------------------------------------------------------------
    # Lifecycle
    # ---------------------------------------------------------------------

    def on_mount(self) -> None:
        self.mount(self._header)
        self.mount(self._body)
        self.mount(self._input)
        self.mount(self._footer)
        self.store.subscribe(self._on_store_change)
        self._render()
        # Session countdown ticks once per second; only the header is touched
        # so the rest of the screen never redraws or jumps while the timer runs.
        self.set_interval(TICK_MS, self._tick_clock, pause=False)

    def _on_store_change(self) -> None:
        # Store notifications can arrive from the agent worker thread — route
        # the re-render back to the Textual event loop. When the store is
        # mutated from the UI thread itself (key presses), call_from_thread
        # raises RuntimeError ("must run in a different thread from the app")
        # — render inline instead, or typing would never appear on screen.
        try:
            self.call_from_thread(self._render)
        except RuntimeError:
            self._render()
        except Exception:
            pass

    def _tick_clock(self) -> None:
        # Live session countdown — re-render the header only (the countdown
        # lives there). The body/input are untouched so nothing flickers.
        state = RemoteProvider.shared_session()
        if state and state.get("sessionExpiresAt"):
            self._header.update(self._render_header())

    # ---------------------------------------------------------------------
    # Rendering
    # ---------------------------------------------------------------------

    def _render(self) -> None:
        self._header.update(self._render_header())
        self._body.update(self._render_body())
        self._input.update(self._render_input())
        self._footer.update(self._render_footer())

    # ------------------------------------------------------------------
    # Header — one clean line: GRACE + subtle model/session status.
    # ------------------------------------------------------------------

    def _render_header(self) -> str:
        store = self.store
        info = store.info
        columns = self.size.width if self.size else 80
        sym = symbols()

        model = self._model_label(info)
        state = RemoteProvider.shared_session()
        session_num = ""
        left_seconds = None
        if state and isinstance(state.get("currentSession"), (int, float)):
            total = state.get("sessionsUsed", 0) + (state.get("sessionsRemaining") or 0)
            session_num = f"Session {state.get('currentSession')}/{total}"
            left_seconds = session_seconds_left(state.get("sessionExpiresAt"))

        right = ""
        if columns >= 78:
            parts: list[str] = []
            if session_num:
                parts.append(session_num + (f" · {format_countdown(left_seconds)} left" if left_seconds is not None else ""))
            if model:
                parts.append(model)
            if info.get("session") and info.get("session") != "Local mode":
                parts.append(_esc(info["session"]))
            if parts:
                # Cap the whole status strip so it never overflows the row.
                right = "   " + f"[{DIM}]{_fit(' · '.join(parts), max(10, columns - 14))}[/]"
        elif columns >= 46:
            if model:
                right = f"   [{DIM}]{_fit(model, 34)}[/]"
            elif session_num and left_seconds is not None:
                right = f"   [{DIM}]{session_num} · {format_countdown(left_seconds)} left[/]"

        lines = [f"[bold {ACCENT}]{wordmark()}[/]{right}"]
        lines.append(f"[{FAINT}]{sym['hLine'] * max(12, min(columns - 4, 120))}[/]")
        return "\n".join(lines)

    def _model_label(self, info: dict) -> str:
        if info.get("providerAvailable"):
            return _esc(info.get("model") or info.get("provider") or "")
        return _esc(info.get("providerError") or "")

    # ------------------------------------------------------------------
    # Body — overlays first, then home / activity.
    # ------------------------------------------------------------------

    def _render_body(self) -> str:
        store = self.store
        if store.permission:
            return self._render_permission()
        if store.picker:
            return self._render_picker()
        if store.login:
            return self._render_login()
        if store.help_open:
            return self._render_help()

        has_activity = len(store.items) > 0
        show_home = store.mode == "home" and not has_activity and not store.busy
        if show_home:
            return self._render_home()
        if store.palette:
            return self._render_palette() + "\n\n" + self._render_activity()
        return self._render_activity()

    # ------------------------------------------------------------------
    # Home — a quiet workspace landing: wordmark, tagline, shortcuts.
    # ------------------------------------------------------------------

    def _render_home(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        rows = self.size.height if self.size else 24
        panel_height = max(4, rows - CHROME)

        logo = choose_logo_for(columns, rows)
        if rows < 18:
            logo = {"lines": compact_lines(), "width": max(len(line) for line in compact_lines())}
        lines = logo["lines"]

        out: list[str] = []
        content_h = len(lines) + 7
        pad = max(1, (panel_height - content_h) // 3)
        out.extend([""] * pad)
        for line in lines:
            out.append(f"[{ACCENT}]{line}[/]")
        out.append("")
        out.append(f"[{DIM}]{SUBTITLE}[/]")
        out.append("")
        if store.palette:
            out.append(self._render_palette())
            return "\n".join(out)
        if rows >= 15 and columns >= 44:
            out.append(self._render_shortcuts())
            out.append("")
        out.append(f"[{DIM}]Describe a coding task below — I'll work in {_esc(store.info.get('workspace') or 'this directory')}.[/]")
        if rows >= 23:
            out.append("")
            out.append(self._render_status())
        return "\n".join(out)

    def _render_shortcuts(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        with_descriptions = columns >= 112
        with_icons = columns >= 60
        selected = store.shortcut_index if store.focus == "shortcuts" else -1
        parts = []
        for i, c in enumerate(HOME_SHORTCUTS):
            active = i == selected
            icon_table = SHORTCUT_ICONS if supports_unicode() else SHORTCUT_ICONS_ASCII
            icon = f"{icon_table.get(c['name'], '·')} " if with_icons else ""
            desc = f"  {c['description']}" if with_descriptions else ""
            prefix = "› " if active else "  "
            style = f"bold {ACCENT}" if active else DIM
            parts.append(f"[{style}]{prefix}{icon}{c['name']}{desc}[/]")
        return "   ".join(parts)

    def _render_status(self) -> str:
        store = self.store
        info = store.info
        state = RemoteProvider.shared_session()
        model = self._model_label(info) or "—"
        workspace = _esc(info.get("workspace") or "")
        lines = [f"[{DIM}]Workspace    {workspace}[/]", f"[{DIM}]Model        {model}[/]"]
        if state and isinstance(state.get("currentSession"), (int, float)):
            left = session_seconds_left(state.get("sessionExpiresAt"))
            total = state.get("sessionsUsed", 0) + (state.get("sessionsRemaining") or 0)
            countdown = format_countdown(left) if left is not None else ""
            lines.append(f"[{DIM}]Session      {state.get('currentSession')}/{total} · {countdown} left[/]")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Activity — the conversation/task area.
    # ------------------------------------------------------------------

    def _render_activity(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        rows = self.size.height if self.size else 24
        palette_h = 9 if store.palette else 0
        panel_height = max(4, rows - CHROME - palette_h)
        inner = max(1, panel_height - 1)

        items = store.items
        total = len(items)
        scroll = min(store.scroll, max(0, total - 1))
        end = max(0, total - scroll)

        # The latest user prompt is pinned at the top of the followed view so
        # USER REQUEST → ACTIVITY → FINAL ANSWER always reads, even when a
        # long answer overflows the panel on a small terminal.
        user_idx = None
        if scroll == 0:
            for j in range(total - 1, -1, -1):
                if items[j]["kind"] == "user":
                    user_idx = j
                    break
        budget = inner - (1 if scroll > 0 else 0)
        start = end
        while start > 0 and budget > 0:
            start -= 1
            budget -= (2 if items[start]["kind"] == "user" else 1)
        if user_idx is not None:
            start = min(start, user_idx)
        window = items[start:end]

        out: list[str] = []
        if scroll > 0:
            out.append(f"[{DIM}]▲ {scroll} line(s) above — End to follow latest[/]")
        if not window and not store.busy:
            out.append(f"[{DIM}]No output yet — describe a coding task below.[/]")

        i = 0
        while i < len(window):
            item = window[i]
            if item["kind"] == "result":
                block: list[str] = []
                while i < len(window) and window[i]["kind"] == "result":
                    block.append(window[i]["text"])
                    i += 1
                out.extend(self._render_answer_block(block, columns))
                continue
            out.extend(self._render_item(item, columns))
            i += 1

        if store.busy:
            out.append(self._status_line())

        if len(out) > inner:
            if user_idx is not None:
                # Keep the pinned prompt (+ its rule); drop the oldest of the rest.
                out = out[:2] + out[-(inner - 2):]
            else:
                out = out[-inner:]
        return "\n".join(out)

    def _status_line(self) -> str:
        dot = "●" if supports_unicode() else "*"
        return f"[{ACCENT}]{dot}[/] [{DIM}]{_esc(self.store.working_status or 'Working')}[/]"

    def _render_item(self, item: dict, columns: int) -> list[str]:
        """One feed line (plus its separator when it is a user prompt)."""
        kind = item["kind"]
        text = _esc(item["text"])
        sym = symbols()
        check, cross = _esc(sym["check"]), _esc(sym["cross"])
        if kind == "user":
            rule = sym["hLine"] * max(12, min(columns - 8, 56))
            return [f"[bold {USER}]{_prompt_arrow()} {text}[/]", f"[{FAINT}]{rule}[/]"]
        if kind == "tool":
            # In-progress activity — cyan, settles in place into ✓ / ✗.
            return [f"[{ACCENT}]{text}[/]"]
        if kind == "success":
            if text.lstrip().startswith(check):
                return [f"[{SUCCESS}]{text}[/]"]
            return [f"[{SUCCESS}]{check}[/] [{TEXT}]{text}[/]"]
        if kind == "error":
            if text.lstrip().startswith(cross):
                return [f"[{ERROR}]{text}[/]"]
            return [f"[{ERROR}]{cross}[/] [{TEXT}]{text}[/]"]
        if kind == "file":
            return [f"[{SUCCESS}]+[/] [{TEXT}]{text}[/]"]
        if kind in ("info", "progress"):
            return [f"[{DIM}]· {text}[/]"]
        if kind == "console":
            return [f"[{DIM}]{text}[/]"]
        return [f"[{TEXT}]{text}[/]"]

    def _render_answer_block(self, lines: list[str], columns: int) -> list[str]:
        """The final answer stands apart: a thin rule, then the block — never
        styled like another tool log."""
        sym = symbols()
        width = max(16, min(columns - 8, 64))
        out = [f"[{DIM}]{sym['hLine'] * width}[/]"]
        for idx, line in enumerate(lines):
            stripped = line.lstrip()
            if idx == 0 and stripped.startswith(sym["check"]):
                out.append(f"[{SUCCESS}]{_esc(line)}[/]")
                out.append("")
            elif idx == 0 and stripped.startswith(sym["cross"]):
                out.append(f"[{ERROR}]{_esc(line)}[/]")
                out.append("")
            elif stripped.endswith(":") and len(stripped) <= 22:
                out.append("")
                out.append(f"[{ACCENT}]{_esc(line)}[/]")
            elif line.startswith("  ") and " · " in line:
                out.append(f"[{DIM}]{_esc(line)}[/]")
            else:
                out.append(f"[{TEXT}]{_esc(line)}[/]")
        return out

    # ------------------------------------------------------------------
    # Input — the FIXED bar at the bottom (never scrolls away).
    # ------------------------------------------------------------------

    def _render_input(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        sym = symbols()
        inner = max(8, columns - 6)
        prefix = _prompt_arrow() + " "
        visible = max(1, inner - len(prefix) - 2)

        text = store.input
        cursor = store.cursor
        start = cursor - visible // 2
        if start < 0:
            start = 0
        if start > len(text) - visible:
            start = max(0, len(text) - visible)
        view = text[start:start + visible]
        cursor_in_view = min(visible - 1, cursor - start)
        before = view[:cursor_in_view]
        at = view[cursor_in_view:cursor_in_view + 1]
        after = view[cursor_in_view + 1:]

        focused = store.focus == "input"
        border = ACCENT if focused else FAINT

        if text == "":
            placeholder = "Grace is working… (Ctrl+C to cancel)" if store.busy else "Enter a coding task or / for commands"
            shown = _fit(placeholder, max(8, visible))
            content = f"[{DIM}]{_esc(shown)}[/]"
            pad = max(0, inner - len(shown))
        else:
            content = f"{_esc(before)}[reverse]{_esc(at or ' ')}[/]{_esc(after)}"
            # The cursor block is one visible cell even at end-of-text, so pad
            # against the real rendered length to keep the box borders aligned.
            pad = max(0, inner - (len(before) + len(at or " ") + len(after)))

        top = f"[{border}]{sym['cornerTl']}{sym['hLine'] * (columns - 2)}{sym['cornerTr']}[/]"
        row = f"[{border}]{sym['vLine']}[/] [{ACCENT}]{prefix}[/]{content}{' ' * pad} [{border}]{sym['vLine']}[/]"
        bottom = f"[{border}]{sym['cornerBl']}{sym['hLine'] * (columns - 2)}{sym['cornerBr']}[/]"
        return "\n".join([top, row, bottom])

    def _render_footer(self) -> str:
        return f"[{DIM}]Ctrl+C cancel · Ctrl+L clear · Tab focus · /help commands[/]"

    # ---------------------------------------------------------------------
    # Overlays
    # ---------------------------------------------------------------------

    def _overlay_frame(self, title: str, inner_lines: list[str]) -> str:
        sym = symbols()
        width = 62
        out = [f"[{ACCENT}]{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}[/]"]
        out.append(f"[{ACCENT}]{sym['vLine']} {title.ljust(width - 3)}{sym['vLine']}[/]")
        for line in inner_lines:
            out.append(f"[{ACCENT}]{sym['vLine']}[/] {line}")
        out.append(f"[{ACCENT}]{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}[/]")
        return "\n".join(out)

    def _render_permission(self) -> str:
        p = self.store.permission
        if not p:
            return ""
        lines = [
            "[grey]Grace wants to run:[/]",
            "",
            f"[bold {ACCENT}]  {_esc(p['command'])}[/]",
            "",
            *[f"[#facc15]  flagged: {_esc(r)}[/]" for r in p["reasons"]],
            "",
            "[dim]Y Allow · N Deny · A Always allow · Esc Deny[/]",
        ]
        return self._center(self._overlay_frame("Permission required", lines))

    def _render_picker(self) -> str:
        p = self.store.picker
        if not p:
            return ""
        lines = [
            f"[dim grey]{('filter: ' + p['filter']) if p['filter'] else 'type to filter · ↑↓ / j k · Enter select · Esc cancel'}[/]",
            "",
        ]
        for i, opt in enumerate(p["options"][:12]):
            selected = i == p["selected"]
            marker = "›" if selected else " "
            current = "  (current)" if opt.get("current") else ""
            hint = f"  {opt['hint']}" if opt.get("hint") else ""
            style = f"bold {ACCENT}" if selected else "grey"
            lines.append(f"[{style}]{marker} {_esc(opt['label'])}{current}[/][dim grey]{_esc(hint)}[/]")
        if not p["options"]:
            lines.append("[#facc15]No matches[/]")
        return self._center(self._overlay_frame(p["title"], lines))

    def _render_palette(self) -> str:
        store = self.store
        rows = store.palette_rows()
        sym = symbols()
        width = 60
        lines = ["[dim grey]Commands[/]", ""]
        for i, c in enumerate(rows):
            selected = i == (store.palette.get("selected") if store.palette else 0)
            marker = "›" if selected else " "
            style = f"bold {ACCENT}" if selected else "grey"
            lines.append(f"[{style}]{marker} {c['name']}[/][dim grey]  {c['description']}[/]")
        if not rows:
            lines.append("[#facc15]No matching commands[/]")
        out = [f"[{ACCENT}]{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}[/]"]
        for line in lines:
            out.append(f" {line}")
        out.append(f"[{ACCENT}]{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}[/]")
        return "\n".join(out)

    def _render_help(self) -> str:
        lines = []
        for c in SLASH_COMMANDS:
            lines.append(f"[{ACCENT}]{c['name'].ljust(12)}[/][grey]{c['description']}[/]")
        lines.append("")
        lines.append("[dim grey]Esc closes this · every command above works[/]")
        return self._center(self._overlay_frame("Commands", lines))

    def _render_login(self) -> str:
        login = self.store.login
        if not login:
            return ""
        fields = [("email", "Email", login["email"], False)]
        fields.append(("password", "Password", login["password"], True))
        if login["purpose"] == "register":
            fields.append(("confirm", "Confirm", login["confirm"], True))

        lines = []
        for key, label, value, masked in fields:
            active = login["field"] == key
            display = "•" * len(value) if masked else _esc(value)
            cursor_char = "█" if active else " "
            style = f"bold {ACCENT}" if active else "grey"
            lines.append(f"[{style}]{label.ljust(10)}[/] [grey] [/]{display}{cursor_char}")
        if login.get("error"):
            lines.append(f"[{ERROR}]{login['error']}[/]")
        lines.append("")
        lines.append("[dim grey]Tab: next field · Enter: submit · Esc: cancel[/]")
        title = "Log in" if login["purpose"] == "login" else "Create account"
        return self._center(self._overlay_frame(title, lines))

    def _center(self, block: str) -> str:
        lines = block.split("\n")
        rows = self.size.height if self.size else 24
        pad = max(0, (rows - len(lines)) // 2 - 2)
        return "\n" * pad + block

    # ---------------------------------------------------------------------
    # Key handling
    # ---------------------------------------------------------------------

    def on_key(self, event: Key) -> None:
        store = self.store
        key = event.key
        char = event.character

        def handled():
            event.stop()

        # 1. Overlays take priority.
        if store.permission:
            if key == "escape" or char in ("n", "N"):
                store.answer_permission(False)
            elif char in ("y", "Y"):
                store.answer_permission(True)
            elif char in ("a", "A"):
                self.runner.remember_prefix(store.permission["command"])
                store.answer_permission(True)
            handled()
            return

        if store.picker:
            if key == "escape":
                store.close_picker()
            elif key == "enter":
                store.picker_select()
            elif key == "up" or char == "k":
                store.picker_move(-1)
            elif key == "down" or char == "j":
                store.picker_move(1)
            elif key == "backspace":
                store.picker_filter(store.picker["filter"][:-1])
            elif char and "ctrl" not in key:
                store.picker_filter(store.picker["filter"] + char)
            handled()
            return

        if store.login:
            if key == "escape":
                store.close_login()
            elif key == "enter":
                self.runner.submit_auth()
            elif key == "tab":
                store.login_next_field()
            elif key == "up":
                store.login_set_field("email")
            elif key == "down":
                store.login_set_field("confirm" if store.login.get("purpose") == "register" else "password")
            elif key == "backspace":
                store.login_backspace()
            elif char and "ctrl" not in key:
                store.login_type(char)
            handled()
            return

        if store.palette:
            store.set_palette_commands(SLASH_COMMANDS)
            if key == "escape":
                store.clear_input()
            elif key == "enter":
                rows = store.palette_rows()
                selected = store.palette.get("selected", 0) if store.palette else 0
                sel = rows[selected] if selected < len(rows) else None
                if sel and store.input != sel["name"] and not store.input.startswith(sel["name"] + " "):
                    text = sel["name"]
                else:
                    text = store.input
                self._submit(text)
            elif key == "up" or char == "k":
                store.palette_move(-1)
            elif key == "down" or char == "j":
                store.palette_move(1)
            elif key == "backspace":
                store.backspace()
            elif char and "ctrl" not in key:
                store.insert(char)
            handled()
            return

        if store.help_open:
            if key in ("escape", "enter") or char in ("q", "Q"):
                store.close_help()
            handled()
            return

        # 2. Global shortcuts. Ctrl+C cancels the running task; when idle it
        # arms an exit that needs a second press within 2s — normal keyboard
        # input never drops the user out of the TUI.
        if key == "ctrl+c":
            if self.runner.is_busy():
                self.runner.cancel_task()
            else:
                now = time.monotonic()
                if self._exit_armed_at is not None and now - self._exit_armed_at < 2.0:
                    self.on_exit()
                else:
                    self._exit_armed_at = now
                    store.push("info", "Press Ctrl+C again to exit Grace.")
            handled()
            return
        if key == "ctrl+d" and not self.runner.is_busy():
            self.on_exit()
            handled()
            return
        if key == "ctrl+l":
            store.clear_activity()
            handled()
            return
        if key == "ctrl+r":
            store.refresh()
            handled()
            return
        if key == "tab":
            store.toggle_focus()
            handled()
            return
        if key == "pageup":
            store.scroll_up(max(1, (self.size.height if self.size else 24) - 8))
            handled()
            return
        if key == "pagedown":
            store.scroll_down(max(1, (self.size.height if self.size else 24) - 8))
            handled()
            return
        if key == "escape":
            if store.focus == "shortcuts":
                store.set_focus("input")
            elif store.input:
                store.clear_input()
            handled()
            return

        # 2b. Home shortcut row (focused via Tab).
        if store.focus == "shortcuts":
            if key == "left":
                store.shortcut_move(-1)
            elif key == "right":
                store.shortcut_move(1)
            elif key == "enter":
                shortcut = HOME_SHORTCUTS[store.shortcut_index]
                if shortcut:
                    self._submit(shortcut["name"])
            elif char and "ctrl" not in key:
                store.set_focus("input")
                store.insert(char)
            handled()
            return

        # 3. Focus-specific (activity scroll).
        if store.focus == "activity":
            if key == "up":
                store.scroll_up(1)
            elif key == "down":
                store.scroll_down(1)
            elif key == "home":
                store.scroll_up(10_000)
            elif key == "end":
                store.scroll_to_bottom()
            elif key == "enter":
                store.toggle_focus()
            handled()
            return

        # 4. Input editing (real text editing).
        if key == "enter":
            self._submit(store.input)
            handled()
            return
        if key == "up":
            store.history_up()
            handled()
            return
        if key == "down":
            store.history_down()
            handled()
            return
        if key == "left":
            store.move_left()
            handled()
            return
        if key == "right":
            store.move_right()
            handled()
            return
        if key == "home" or key == "ctrl+a":
            store.home()
            handled()
            return
        if key == "end" or key == "ctrl+e":
            store.end()
            handled()
            return
        if key == "backspace":
            store.backspace()
            handled()
            return
        if key == "delete":
            store.delete()
            handled()
            return
        if char and "ctrl" not in key and not key.startswith("ctrl"):
            store.insert(char)
            handled()

    def _submit(self, text: str) -> None:
        trimmed = text.strip()
        if not trimmed or self.runner.is_busy():
            return
        self.store.submit_input()
        if trimmed.startswith("/"):
            self.runner.run_slash(trimmed)
        else:
            self.runner.run_task(trimmed)
