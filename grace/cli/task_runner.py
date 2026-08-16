"""Task execution through the coordinator (port of src/cli/taskRunner.ts).

Renders concise structured progress without exposing any agent chain-of-
thought, then prints composed result sections (Done / Files changed /
Validation / Provider / Time / follow-ups), the GRACE FREE quota line and
usage reporting.
"""

import time

from grace.agent.loop import TaskCancelledError
from grace.agents.coordinator import Coordinator
from grace.agents.fast_router import classify_task, conversation_reply
from grace.agents.role_router import RoleModelRouter
from grace.auth.reporting import report_run_usage
from grace.auth.session import load_session, session_expired
from grace.cli.free_plan import session_rollover_note, session_status_line
from grace.cli.ui.progress import ProgressRenderer
from grace.cli.ui.results import render_error, render_task_result
from grace.cli.ui.theme import symbols
from grace.colors import c
from grace.project.index import ProjectIndexService
from grace.providers.remote import RemoteProvider
from grace.verbose import is_verbose

# One shared, maintained project index per runtime (survives across tasks).
_index_by_runtime: dict[int, ProjectIndexService] = {}


def run_task(runtime, input_text: str, opts: dict | None = None) -> int:
    """Run one user task through the GRACE coordinator. Returns an exit code."""
    opts = opts or {}
    # Greetings never need a provider, an index or any agent — answer instantly.
    route = classify_task(input_text)
    if route == "conversation":
        print(conversation_reply(input_text))
        return 0

    if not runtime.provider:
        print(render_error(runtime.provider_error or "No AI provider configured."))
        return 1

    index = _index_by_runtime.get(id(runtime))
    if index is None:
        index = ProjectIndexService(runtime.root)
        _index_by_runtime[id(runtime)] = index

    print("")
    started_at = time.monotonic() * 1000
    role_router = RoleModelRouter(runtime)
    served = runtime.provider.server_provider if isinstance(runtime.provider, RemoteProvider) else None
    verbose = opts.get("verbose") if opts.get("verbose") is not None else is_verbose()
    progress = ProgressRenderer({
        "verbose": verbose,
        "providerLabel": (served or {}).get("label") or runtime.provider.label if verbose else None,
        "model": runtime.provider.get_model().id if verbose else None,
    })
    coordinator = Coordinator({
        "runtime": runtime,
        "projectIndex": index,
        "onEvent": progress.event,
        "providerFactory": (lambda role, spec: runtime.provider if role == "editor" else role_router.provider_for(role, spec)),
        "plannerProvider": role_router.planner_provider(),
        "signal": opts.get("signal"),
    })

    try:
        result = coordinator.run(input_text)
    except TaskCancelledError:
        progress.end()
        print("")
        print(c.dim("Cancelled."))
        return 0
    except Exception as err:
        progress.end()
        print(render_error("Task failed", str(err)))
        return 1
    progress.end()

    execution_time_ms = time.monotonic() * 1000 - started_at
    print("")

    # The editor may have changed files — make sure the next task sees a fresh index.
    if result.changedFiles:
        index.invalidate()

    if result.route == "conversation":
        print(result.finalAnswer)
        return 0

    print(render_task_result({"result": result, "runtime": runtime, "executionTimeMs": execution_time_ms, "verbose": verbose}))

    # GRACE FREE: daily session quota from the server's latest response.
    stored = load_session()
    if stored and not session_expired(stored):
        last = RemoteProvider.shared_session()
        if last:
            line = session_status_line(last)
            if line:
                print(line)
            if last.get("startedNew"):
                print(session_rollover_note(last))

    def report() -> str:
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
            print(f"{symbols()['bullet']} usage report failed (backend offline) — run continued locally.")
        return outcome

    if opts.get("awaitUsageReport"):
        report()

    return 0
