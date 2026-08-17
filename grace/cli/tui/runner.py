"""TUI task runner (port of src/cli/tui/runner.ts).

The presentation-layer counterpart of grace/cli/task_runner.py: routes a task
through the SAME agent machinery (fast router → coordinator → primary agent →
tools) but renders into the TUI activity feed instead of stdout, and surfaces
permission requests as interactive dialogs.

The Python agent loop is synchronous, so tasks run in a worker thread while
the Textual UI stays responsive. All output is pushed through the store as
ANSI-free lines; the renderer applies colors by kind. Chain-of-thought is
never rendered.
"""

import threading
import time

from grace.agent.loop import TaskCancelledError
from grace.agents.coordinator import Coordinator
from grace.agents.fast_router import classify_task, conversation_reply
from grace.agents.role_router import RoleModelRouter
from grace.auth.client import ApiClient, ApiError
from grace.auth.reporting import report_run_usage
from grace.auth.session import load_session, save_session, session_expired
from grace.cli.free_plan import session_rollover_note, session_status_line
from grace.cli.tui.events import TuiEventAdapter
from grace.cli.tui.info import build_tui_info
from grace.cli.tui.models import apply_model_selection, apply_provider_selection, discover_models, discover_providers
from grace.cli.ui.results import render_error, render_task_result
from grace.cli.ui.theme import strip_ansi
from grace.config import zeesh_api_url
from grace.project.index import ProjectIndexService
from grace.providers.remote import RemoteProvider
from grace.verbose import is_verbose


def _command_prefix(command: str) -> str:
    first = (command.strip().split() or [""])[0]
    return "".join(ch for ch in first if ch.isalnum() or ch in "._-")


class TuiRunner:
    def __init__(self, opts: dict) -> None:
        self.runtime = opts["runtime"]
        self.store = opts["store"]
        self.on_exit = opts.get("onExit") or (lambda: None)
        self.make_runtime = opts["makeRuntime"]
        self._index_by_runtime: dict[int, ProjectIndexService] = {}
        self._abort = None
        self._approved_prefixes: set[str] = set()
        self._task_running = False
        self._thread: threading.Thread | None = None
        # The UI event adapter: the only channel agent events use to reach the
        # store. Tool lines update in place ("Reading x" → "✓ Read x"), the
        # working status stays a single live line, and raw diagnostics stay out.
        self.events = TuiEventAdapter(self.store)

    def get_runtime(self):
        return self.runtime

    def is_busy(self) -> bool:
        return self._task_running

    def cancel_task(self) -> None:
        if self._abort is not None:
            self._abort.abort()
        self.store.push("info", "Cancel requested — stopping…")

    # ---------------------------------------------------------------------
    # Tasks
    # ---------------------------------------------------------------------

    def run_task(self, input_text: str) -> None:
        """Start a task in a worker thread (the agent loop is synchronous)."""
        store = self.store
        runtime = self.runtime

        store.push("user", input_text)
        store.mode = "session"
        store.scroll_to_bottom()

        route = classify_task(input_text)
        if route == "conversation":
            store.push("system", conversation_reply(input_text))
            return

        if not runtime.provider:
            store.push("error", strip_ansi(render_error(runtime.provider_error or "No AI provider configured.")))
            return

        thread = threading.Thread(target=self._run_task_worker, args=(input_text,), daemon=True)
        thread.start()

    def _run_task_worker(self, input_text: str) -> None:
        runtime = self.runtime
        store = self.store
        try:
            index = self._index_by_runtime.get(id(runtime))
            if index is None:
                index = ProjectIndexService(runtime.root)
                self._index_by_runtime[id(runtime)] = index

            started_at = time.monotonic() * 1000
            store.set_busy(True)
            self._task_running = True
            self._abort = _AbortFlag()

            role_router = RoleModelRouter(runtime)
            verbose = is_verbose()
            coordinator = Coordinator({
                "runtime": runtime,
                "projectIndex": index,
                "onEvent": self._handle_coordinator_event,
                "providerFactory": (lambda role, spec: runtime.provider if role == "editor" else role_router.provider_for(role, spec)),
                "plannerProvider": role_router.planner_provider(),
                "signal": self._abort,
            })

            try:
                result = coordinator.run(input_text)
            except TaskCancelledError:
                store.push("info", "Cancelled.")
                return
            except Exception as err:
                store.push("error", strip_ansi(render_error("Task failed", str(err))))
                return

            if result.changedFiles:
                index.invalidate()
            if result.route == "conversation":
                store.push("system", result.finalAnswer)
                return

            execution_time_ms = time.monotonic() * 1000 - started_at
            store.push("result", strip_ansi(render_task_result({"result": result, "runtime": runtime, "executionTimeMs": execution_time_ms, "verbose": verbose})))
            store.clear_working_status()

            # GRACE FREE: quota from the server's latest response (real state).
            stored = load_session()
            if stored and not session_expired(stored):
                last = RemoteProvider.shared_session()
                if last:
                    line = session_status_line(last)
                    if line:
                        store.push("info", strip_ansi(line))
                    if last.get("startedNew"):
                        store.push("info", strip_ansi(session_rollover_note(last)))

            outcome = report_run_usage({
                "prompt": input_text,
                "model": runtime.provider.get_model().id,
                "projectType": runtime.project.type,
                "iterations": result.iterations,
                "toolCalls": result.toolCalls,
                "usage": result.usage,
                "executionTimeMs": execution_time_ms,
            })
            if outcome == "failed":
                store.push("console", "usage report failed (backend offline) — run continued locally.")
        except Exception as err:
            store.push("error", f"Task failed unexpectedly: {err}")
        finally:
            self._task_running = False
            self._abort = None
            store.set_busy(False)

    def _handle_coordinator_event(self, e: dict) -> None:
        # Single channel from the agent to the UI: the event adapter decides
        # what is safe to show and how it lands in the store.
        self.events.handle(e)

    def ask_permission(self, command: str, reasons: list[str]) -> bool:
        prefix = _command_prefix(command)
        if prefix and prefix in self._approved_prefixes:
            return True
        return self.store.ask_permission(command, reasons)

    def remember_prefix(self, command: str) -> None:
        prefix = _command_prefix(command)
        if prefix:
            self._approved_prefixes.add(prefix)

    # ---------------------------------------------------------------------
    # Slash commands
    # ---------------------------------------------------------------------

    def run_slash(self, raw: str) -> bool:
        """Execute a slash command; returns True when Grace should exit."""
        parts = raw.strip().split()
        cmd = parts[0] if parts else ""
        arg = " ".join(parts[1:])
        if not cmd:
            return False
        from grace.cli.tui.commands_tui import handle_tui_slash

        should_exit = handle_tui_slash(self, self.store, cmd, arg)
        if should_exit:
            self.on_exit()
        return should_exit

    # ---------------------------------------------------------------------
    # Model / provider pickers
    # ---------------------------------------------------------------------

    def open_model_picker(self) -> None:
        store = self.store
        runtime = self.runtime
        if not runtime.provider:
            store.push("error", strip_ansi(render_error(runtime.provider_error or "No AI provider configured.")))
            return
        store.push("info", "Fetching available models…")
        options = discover_models(runtime)
        if not options:
            store.push("info", "Could not list models for this provider — set one directly with /model <id>.")
            return
        store.open_picker(
            "model",
            "Models",
            options,
            lambda opt, idx: self._on_model_selected(opt),
        )

    def _on_model_selected(self, opt: dict) -> None:
        err = apply_model_selection(self.runtime, opt["value"])
        if err:
            self.store.push("error", err)
        else:
            self.store.push("success", f"Model set to {opt['value']} (saved).")
        self.refresh_info()

    def open_provider_picker(self) -> None:
        store = self.store
        options = discover_providers(self.runtime)
        if not options:
            store.push("info", "No providers configured — add GROQ_API_KEY to .env or run /login to use the GRACE backend.")
            return
        store.open_picker(
            "provider",
            "Providers",
            options,
            lambda opt, idx: self._on_provider_selected(opt),
        )

    def _on_provider_selected(self, opt: dict) -> None:
        err = apply_provider_selection(self.runtime, opt["value"])
        if err:
            self.store.push("error", err)
        else:
            self.store.push("success", f"Provider set to {opt['label']}.")
        self.refresh_info()

    # ---------------------------------------------------------------------
    # Login / register
    # ---------------------------------------------------------------------

    def submit_auth(self) -> None:
        store = self.store
        login = store.login
        if not login or login.get("busy"):
            return
        store.login_busy()

        email = login["email"].strip()
        password = login["password"]

        if not email or not password:
            store.login_error("Email and password are required.")
            return
        if login["purpose"] == "register" and len(password) < 8:
            store.login_error("Password must be at least 8 characters.")
            return
        if login["purpose"] == "register" and password != login["confirm"]:
            store.login_error("Passwords do not match.")
            return

        # Configuration only (ZEESH_API_URL override, else the deployed backend).
        api_url = zeesh_api_url()
        api = ApiClient(api_url)
        try:
            if login["purpose"] == "login":
                result = api.login(email, password)
            else:
                result = api.register(email, password)
            save_session({
                "apiUrl": api_url,
                "token": result["token"],
                "user": {"id": result["user"]["id"], "email": result["user"]["email"], "displayName": result["user"].get("display_name")},
                "expiresAt": result["expires_at"],
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            })
            store.close_login()
            store.push("success", f"Logged in as {result['user']['email']}." if login["purpose"] == "login" else f"Account created — logged in as {result['user']['email']}.")
            self.refresh_info()
        except ApiError as err:
            if err.status == 401:
                store.login_error("Invalid email or password. No account yet? Try /register.")
            elif err.status == 429:
                store.login_error(f"Too many attempts — try again in {err.retry_after_seconds or 60}s.")
            elif err.status == 409:
                store.login_error("An account with this email already exists. Try /login.")
            elif err.status == 403:
                store.login_error(str(err))
            else:
                store.login_error(str(err))
        except Exception as err:
            store.login_error(str(err) or "Request failed.")

    def refresh_info(self) -> None:
        self.store.info = build_tui_info(self.runtime, self.store.info.get("freePlan"))
        self.store.notify()

    def set_runtime(self, runtime) -> None:
        self.runtime = runtime


class _AbortFlag:
    """Minimal abort signal so Ctrl+C cancels an in-flight task safely."""

    def __init__(self) -> None:
        self._aborted = False

    def abort(self) -> None:
        self._aborted = True

    @property
    def aborted(self) -> bool:
        return self._aborted
