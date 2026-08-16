"""Grace progress rendering (port of src/cli/ui/progress.ts — primary-agent UX).

Turns coordinator events into concise, non-chain-of-thought progress:

    · Grace is working…
    • → read_file src/auth/login.ts
    • → edit_file src/auth/login.ts
    • → run_command npm test
    → Grace ✓ — Authentication added

- One line per meaningful event: a live working line, settled status bullets
  and one settled line per finished agent.
- The provider/model header and specialist agent names are DEBUG output only.
- The working line is redrawn in place with a subtle spinner on TTY; on plain
  output every line is printed deterministically as it settles.
"""

import re
import sys
import threading

from grace.cli.ui.theme import supports_ansi, symbols, theme, visual_width

SPINNER_MS = 0.12
MAX_LIVE_ROWS = 12


def _one_liner(text: str) -> str:
    """Collapse a summary to a single line, capped for the progress list."""
    flat = re.sub(r"\s+", " ", text).strip()
    return f"{flat[:89]}…" if len(flat) > 90 else flat


def _is_noise(message: str) -> bool:
    m = message.strip()
    return m in ("Thinking…", "Thinking...") or re.match(r"^Done in \d+ iteration", m) is not None or m.startswith("    ⚙ ")


class ProgressRenderer:
    """Renders coordinator events as concise progress lines.

    In live (TTY) mode the block redraws in place with a spinner; in plain
    mode every settled line prints deterministically. Never prints
    chain-of-thought — only statuses, tool names and agent completions.
    """

    def __init__(self, opts: dict | None = None) -> None:
        opts = opts or {}
        self.out = opts.get("out") or (lambda text: sys.stdout.write(text))
        self.live = opts.get("live") if opts.get("live") is not None else (bool(sys.stdout.isatty()) and supports_ansi())
        self.verbose = opts.get("verbose") or False
        self.columns = opts.get("columns") or getattr(sys.stdout, "columns", None) or 80
        self.sym = symbols()
        self.th = theme()
        provider_label = opts.get("providerLabel")
        model = opts.get("model")
        self.provider_line = None
        if self.verbose and provider_label and model:
            self.provider_line = "  " + self.th["dim"](f"Grace {self.sym['bullet']} {provider_label} {self.sym['bullet']} {model}")

        self.suppressed = False
        self.header_printed = False
        self.planning: str | None = None
        self.step_header: str | None = None
        self.current: str | None = None
        self.settled: list[str] = []
        self.painted_rows = 0
        self._spinner_timer: threading.Timer | None = None
        self._frame = 0

    # -------------------------------------------------------------------------
    # Events
    # -------------------------------------------------------------------------

    def event(self, evt: dict) -> None:
        if self.suppressed:
            return
        etype = evt.get("type")
        if etype == "route":
            if evt.get("route") == "conversation":
                self.suppressed = True
        elif etype == "planning":
            if not self.verbose:
                return
            self.planning = "  " + self.th["dim"](self.sym["bullet"] + " Planning" + self.sym["ellipsis"])
            if not self.live:
                self.print(f"{self.planning}\n")
            else:
                self.paint()
        elif etype == "working":
            self.set_current("  " + self.th["dim"](self.sym["bullet"] + " Grace is working" + self.sym["ellipsis"]))
        elif etype == "status":
            # Status lines are internal activity — normal mode shows only the working line.
            if not self.verbose or _is_noise(evt.get("message") or ""):
                return
            self.add_settled(f"  {self.sym['dot']} {evt['message']}")
        elif etype == "step-start":
            self.flush_current()
            if self.verbose:
                self.step_header = "  " + self.th["dim"](f"Step {evt.get('step')}/{evt.get('total')}")
            else:
                self.step_header = None
            if self.step_header and not self.live:
                self.print(f"{self.step_header}\n")
            else:
                self.paint()
        elif etype == "agent-start":
            # The primary agent (Grace) is covered by the 'working' line — only
            # specialist agents get their own start line, and only in debug mode.
            if evt.get("role") != "editor" and self.verbose:
                self.set_current("  " + self.th["dim"](self.sym["bullet"] + " " + (evt.get("label") or "") + self.sym["ellipsis"]))
        elif etype == "agent-done":
            self.set_current(None)
            self.add_settled(f"  {self.sym['arrow']} {self._render_done(evt)}")
        elif etype == "done":
            self.flush_current()
            self.paint()

    def end(self) -> None:
        """Finish the run: settle any leftovers and stop the spinner."""
        self.flush_current()
        self.paint()

    # -------------------------------------------------------------------------
    # Rendering
    # -------------------------------------------------------------------------

    def _render_done(self, evt: dict) -> str:
        status = evt.get("status")
        if status == "completed":
            mark = self.th["success"](self.sym["check"])
        elif status == "failed":
            mark = self.th["error"](self.sym["cross"])
        else:
            mark = self.th["warn"](self.sym["warn"])
        if status == "completed":
            text = evt.get("summary") or ""
        elif status == "failed":
            text = evt.get("error") or evt.get("summary") or ""
        else:
            text = evt.get("summary") or ""
        detail = " " + self.th["dim"](f"— {_one_liner(text)}") if text else ""
        if evt.get("role") != "editor" and not self.verbose:
            return f"{mark}{detail}"
        return self.th["agent"](evt.get("label")) + " " + mark + detail

    def _ensure_header(self) -> None:
        if self.header_printed:
            return
        self.header_printed = True
        if self.provider_line:
            self.print(f"{self.provider_line}\n")

    def print(self, text: str) -> None:
        self._ensure_header()
        self.out(text)

    def add_settled(self, line: str) -> None:
        self.settled.append(line)
        self._stop_spinner()
        if not self.live:
            self.print(f"{line}\n")
        else:
            self.paint()

    def set_current(self, line: str | None) -> None:
        self.current = line
        if line:
            self._ensure_spinner()
        else:
            self._stop_spinner()
        if not self.live:
            if line:
                self.print(f"{line}\n")
        else:
            self.paint()

    def flush_current(self) -> None:
        self.current = None
        self._stop_spinner()

    def render_all(self) -> list[str]:
        lines: list[str] = []
        if self.provider_line:
            lines.append(self.provider_line)
        if self.planning:
            lines.append(self.planning)
        if self.step_header:
            lines.append(self.step_header)
        lines.extend(self.settled)
        if self.current:
            lines.append(self.current)
        return lines

    # -------------------------------------------------------------------------
    # Live TTY redraw + spinner
    # -------------------------------------------------------------------------

    def paint(self) -> None:
        if not self.live:
            return
        lines = self.render_all()
        rows = sum(max(1, -(-visual_width(line) // self.columns)) for line in lines)
        # A block taller than the viewport estimate would scroll mid-redraw and
        # leave stale rows — settle it as plain, deterministic output instead.
        if rows > MAX_LIVE_ROWS:
            self.settle_to_plain(lines)
            return
        try:
            if self.painted_rows > 0:
                self.out(f"\x1b[{self.painted_rows}A")
                for _ in range(self.painted_rows):
                    self.out("\x1b[2K\x1b[1B")
                self.out(f"\x1b[{self.painted_rows}A")
            if lines:
                self.out(f"{chr(10).join(lines)}\n")
            self.painted_rows = rows
        except Exception:
            self.settle_to_plain(lines)

    def settle_to_plain(self, lines: list[str]) -> None:
        """Permanently print the whole block and stop live redrawing."""
        self.live = False
        self.painted_rows = 0
        self._stop_spinner()
        for line in lines:
            self.out(f"{line}\n")
        self.planning = None
        self.step_header = None
        self.settled = []
        self.current = None

    def _ensure_spinner(self) -> None:
        if not self.live or self._spinner_timer is not None:
            return

        def tick() -> None:
            if not self.live:
                return
            self._frame += 1
            frames = self.sym["spinner"]
            if self.current:
                self.current = self.current.replace(frames[(self._frame - 1) % len(frames)], frames[self._frame % len(frames)])
            self.paint()
            if self.live:
                self._spinner_timer = threading.Timer(SPINNER_MS, tick)
                self._spinner_timer.daemon = True
                self._spinner_timer.start()

        self._spinner_timer = threading.Timer(SPINNER_MS, tick)
        self._spinner_timer.daemon = True
        self._spinner_timer.start()

    def _stop_spinner(self) -> None:
        if self._spinner_timer is not None:
            self._spinner_timer.cancel()
            self._spinner_timer = None
