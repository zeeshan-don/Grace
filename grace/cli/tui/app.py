"""GRACE TUI app (Textual port of src/cli/tui/app.ts + components.ts).

A single Textual App composes the layout (home hero OR session feed + input)
and owns ALL keyboard handling. Keys route by what is currently open
(permission → picker → login → palette → help → global shortcuts →
focus-specific editing), so every interactive element is genuinely wired to
the store.

Layout: the home screen is the full hero (logo → input → shortcuts → status).
After the first task the app switches to the session layout (slim task header
→ activity feed → input). No permanent top/bottom bars.
"""

import threading
import time

from textual.app import App
from textual.events import Key
from textual.widgets import Static

from grace.cli.free_plan import format_countdown, format_daily_usage, session_seconds_left
from grace.cli.tui.commands import HOME_SHORTCUTS, SLASH_COMMANDS
from grace.cli.tui.logo import choose_logo_for, wordmark
from grace.cli.ui.theme import supports_unicode, symbols
from grace.providers.remote import RemoteProvider

SPINNER_MS = 0.12
TICK_MS = 1.0

# Activity kinds → Rich markup styles (mirrors colorForKind).
KIND_STYLE = {
    "user": "bold cyan",
    "system": "dim grey",
    "progress": "dim grey",
    "tool": "cyan",
    "file": "green",
    "success": "green",
    "error": "red",
    "info": "yellow",
    "result": "",
    "console": "dim grey",
}

SHORTCUT_ICONS = {"/help": "▸", "/status": "◇", "/model": "◈", "/provider": "⚙"}
SHORTCUT_ICONS_ASCII = {"/help": "?", "/status": "=", "/model": "*", "/provider": "#"}

SUBTITLE = "A I   C O D I N G   A G E N T"


def _fit(text: str, width: int) -> str:
    if len(text) <= width:
        return text
    if width <= 1:
        return "…"
    return text[: width - 1] + "…"


def _prefix_for(item: dict) -> str:
    sym = symbols()
    kind = item["kind"]
    text = item["text"]
    if kind == "user":
        return "› "
    if kind in ("progress", "info"):
        return "• "
    if kind == "tool":
        return "  "
    if kind == "file":
        return "+ "
    if kind == "success":
        return "" if text.lstrip().startswith(sym["check"]) else f"{sym['check']} "
    if kind == "error":
        return "" if text.lstrip().startswith(sym["cross"]) else f"{sym['cross']} "
    return ""


class GraceTuiApp(App):
    """The GRACE full-screen interface. Renders entirely from the TuiStore."""

    BINDINGS: list = []
    CSS = """
    GraceTuiApp {
        background: #0b0d10;
        color: #d6d6d6;
    }
    """

    def __init__(self, store, runner, on_exit) -> None:
        super().__init__()
        self.store = store
        self.runner = runner
        self.on_exit = on_exit
        self._frame = 0
        self._header = Static("", id="header")
        self._body = Static("", id="body")
        self._input = Static("", id="input-line")
        self._footer = Static("", id="footer")

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
        self.set_interval(SPINNER_MS, self._tick_spinner, pause=False)
        self.set_interval(TICK_MS, self._tick_clock, pause=False)

    def _on_store_change(self) -> None:
        # Store notifications can arrive from the agent worker thread — route
        # the re-render back to the Textual event loop.
        try:
            self.call_from_thread(self._render)
        except Exception:
            pass

    def _tick_spinner(self) -> None:
        self._frame += 1
        if self.store.busy:
            self._render()

    def _tick_clock(self) -> None:
        # Session countdown ticks once per second; re-render only when a live
        # session exists (RemoteProvider shared state), or when the header/
        # status row shows it.
        state = RemoteProvider.shared_session()
        if state and state.get("sessionExpiresAt"):
            self._render()

    # ---------------------------------------------------------------------
    # Rendering
    # ---------------------------------------------------------------------

    def _render(self) -> None:
        store = self.store
        self._header.update(self._render_header())
        self._body.update(self._render_body())
        self._input.update(self._render_input())
        self._footer.update(self._render_footer())

    def _render_header(self) -> str:
        store = self.store
        info = store.info
        sym = symbols()
        columns = self.size.width if self.size else 80
        model = (info.get("model") or info.get("provider") or "") if info.get("providerAvailable") else (info.get("providerError") or "")
        state = RemoteProvider.shared_session()
        session_num = ""
        if state and isinstance(state.get("currentSession"), (int, float)):
            session_num = f"Session {state.get('currentSession')}/{state.get('sessionsUsed', 0) + state.get('sessionsRemaining', 0)} · "

        right = ""
        if columns >= 60:
            right = f"[yellow]{session_num}[/]"
            left_seconds = session_seconds_left(state.get("sessionExpiresAt")) if state else None
            if left_seconds is not None:
                right += f"[yellow]{format_countdown(left_seconds)} left[/]"
        if model:
            right += f" [dim grey]{_fit(model, 44)}[/]"

        lines = [f"[bold cyan]{wordmark()}[/]  {right}"]
        last_user = self._last_user_item()
        if last_user:
            lines.append(f"[bold cyan]›[/] [bold]{_fit(last_user['text'], max(16, columns - 4))}[/]")
        lines.append(f"[dim grey]{sym['hLine'] * max(12, min(columns - 4, 100))}[/]")
        return "\n".join(lines)

    def _last_user_item(self):
        for item in reversed(self.store.items):
            if item["kind"] == "user":
                return item
        return None

    def _render_body(self) -> str:
        store = self.store
        # Overlays take priority.
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

    def _render_home(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        rows = self.size.height if self.size else 24
        logo = choose_logo_for(columns, rows)
        lines = logo["lines"]
        out: list[str] = []
        for line in lines:
            out.append(f"[bold cyan]{line}[/]")
        out.append("")
        out.append(f"[dim grey]{SUBTITLE}[/]")
        out.append("")
        # Input is rendered by the input line widget below — the home body
        # shows shortcuts + status under it.
        if store.palette:
            out.append(self._render_palette())
            return "\n".join(out)
        if rows >= 16 and columns >= 44:
            out.append(self._render_shortcuts())
        if rows >= 23:
            out.append("")
            out.append(f"[dim grey]{symbols()['hLine'] * max(12, min(columns - 8, 56))}[/]")
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
            style = "bold cyan" if active else "dim grey"
            parts.append(f"[{style}]{prefix}{icon}{c['name']}{desc}[/]")
        return "   ".join(parts)

    def _render_status(self) -> str:
        store = self.store
        info = store.info
        busy = store.busy
        sym = symbols()
        model = (info.get("model") or info.get("provider") or "—") if info.get("providerAvailable") else (info.get("providerError") or "no provider")
        status = "working" if busy else "ready"
        status_color = "cyan" if busy else "green"
        state = RemoteProvider.shared_session()
        has_live = bool(state and session_seconds_left(state.get("sessionExpiresAt")) is not None)

        if has_live:
            left = session_seconds_left(state["sessionExpiresAt"])
            quota = f"[dim grey]Quota · Session {state.get('currentSession') or state.get('sessionsUsed')}/{state.get('sessionsUsed', 0) + state.get('sessionsRemaining', 0)} · {format_countdown(left)} left · {format_daily_usage(state.get('dailyUsedSeconds'))} used today[/]"
        elif info.get("freePlan"):
            quota = f"[dim grey]{_fit(info['freePlan'], max(16, (self.size.width if self.size else 80) - 4))}[/]"
        else:
            quota = ""

        lines = [
            f"[dim grey]Workspace    {info.get('workspace', '')}[/]",
            f"[dim grey]Model        {model}[/]",
            f"[dim grey]Session      {info.get('session', '')}[/]",
            f"[{status_color}]{sym['dot']} {status}[/]",
        ]
        if quota:
            lines.append(quota)
        return "\n".join(lines)

    def _render_activity(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        rows = self.size.height if self.size else 24
        chrome = 7  # header (3) + input (3) + footer (1)
        palette_h = 9 if store.palette else 0
        panel_height = max(4, rows - chrome - palette_h)
        inner = max(1, panel_height - 1)

        items = self._without_latest_user(store.items) if True else store.items
        total = len(items)
        scroll = min(store.scroll, max(0, total - 1))
        end = max(0, total - scroll)
        start = max(0, end - inner)
        window = items[start:end]

        out: list[str] = []
        if scroll > 0:
            out.append(f"[yellow]{'▲'} {scroll} line(s) above — End to follow latest[/]")
        if not window and not store.busy:
            out.append("[dim grey]No output yet.[/]")
        for item in window:
            style = KIND_STYLE.get(item["kind"], "")
            prefix = _prefix_for(item)
            if style:
                out.append(f"[{style}]{prefix}{item['text']}[/]")
            else:
                out.append(f"{prefix}{item['text']}")
        if store.busy:
            frames = symbols()["spinner"]
            frame = frames[self._frame % len(frames)]
            out.append(f"[cyan]{frame} Grace is working…[/]")
        return "\n".join(out)

    def _without_latest_user(self, items: list[dict]) -> list[dict]:
        for i in range(len(items) - 1, -1, -1):
            if items[i]["kind"] == "user":
                return [item for j, item in enumerate(items) if j != i]
        return items

    def _render_input(self) -> str:
        store = self.store
        columns = self.size.width if self.size else 80
        total = columns
        inner = max(8, total - 4)
        prefix = "› "
        visible = max(1, inner - len(prefix))

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
        border = "cyan" if focused else "grey"

        if text == "" and not store.busy:
            placeholder = "Grace is working… (Ctrl+C to cancel)" if store.busy else ("What's next?" if store.mode == "session" else "Ask me to build, fix, refactor…")
            content = f"[dim grey]{_fit(placeholder, max(8, visible))}[/]"
        else:
            content = f"{before}[reverse]{at or ' '}[/]{after}"

        busy_mark = " ⏳" if store.busy else ""
        return f"┌─ [bold cyan]›[/] {content}{busy_mark}"

    def _render_footer(self) -> str:
        return "[dim grey]Ctrl+C cancel · Ctrl+L clear · Tab focus · /help commands[/]"

    # ---------------------------------------------------------------------
    # Overlays
    # ---------------------------------------------------------------------

    def _overlay_frame(self, title: str, inner_lines: list[str]) -> str:
        sym = symbols()
        width = 62
        out = [f"[bold cyan]{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}[/]"]
        out.append(f"[bold cyan]{sym['vLine']} {title.ljust(width - 3)}{sym['vLine']}[/]")
        for line in inner_lines:
            out.append(f"[bold cyan]{sym['vLine']}[/] {line}")
        out.append(f"[bold cyan]{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}[/]")
        return "\n".join(out)

    def _render_permission(self) -> str:
        p = self.store.permission
        if not p:
            return ""
        lines = [
            "[grey]Grace wants to run:[/]",
            "",
            f"[bold cyan]  {p['command']}[/]",
            "",
            *[f"[yellow]  flagged: {r}[/]" for r in p["reasons"]],
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
            style = "bold cyan" if selected else "grey"
            lines.append(f"[{style}]{marker} {opt['label']}{current}[/][dim grey]{hint}[/]")
        if not p["options"]:
            lines.append("[yellow]No matches[/]")
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
            style = "bold cyan" if selected else "grey"
            lines.append(f"[{style}]{marker} {c['name']}[/][dim grey]  {c['description']}[/]")
        if not rows:
            lines.append("[yellow]No matching commands[/]")
        out = [f"[bold cyan]{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}[/]"]
        for line in lines:
            out.append(f" {line}")
        out.append(f"[bold cyan]{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}[/]")
        return "\n".join(out)

    def _render_help(self) -> str:
        lines = []
        for c in SLASH_COMMANDS:
            lines.append(f"[cyan]{c['name'].ljust(12)}[/][grey]{c['description']}[/]")
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
            display = "•" * len(value) if masked else value
            cursor_char = "█" if active else " "
            style = "bold cyan" if active else "grey"
            lines.append(f"[{style}]{label.ljust(10)}[/] [grey] [/]{display}{cursor_char}")
        if login.get("error"):
            lines.append(f"[red]{login['error']}[/]")
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
    # Key handling (mirrors app.ts useInput routing)
    # ---------------------------------------------------------------------

    def on_key(self, event: Key) -> None:
        store = self.store
        key = event.key
        char = event.char

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

        # 2. Global shortcuts.
        if key == "ctrl+c":
            if self.runner.is_busy():
                self.runner.cancel_task()
            else:
                self.on_exit()
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

        # 3. Focus-specific.
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
