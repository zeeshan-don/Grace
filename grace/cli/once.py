"""One-shot mode (port of src/cli/once.ts): `grace \"prompt\"`."""

import os
import sys

from grace.cli.task_runner import run_task
from grace.colors import c
from grace.config import load_env
from grace.meta import PRODUCT, VERSION
from grace.runtime import create_runtime
from grace.util_text import short_path
from grace.verbose import is_verbose, set_verbose


def run_once(prompt: str, opts: dict | None = None) -> int:
    opts = opts or {}
    root = os.getcwd()
    load_env(root)
    if opts.get("verbose"):
        set_verbose(True)
    runtime = create_runtime(root, {"yes": opts.get("yes", False), "model": opts.get("model")})

    print(c.dim(f"{PRODUCT} v{VERSION} — one-shot run in {short_path(root, os.path.expanduser('~'))}"))

    if not runtime.provider:
        print(c.red(runtime.provider_error or "No AI provider configured."))
        return 1

    # The whole run (planning, subagents, final answer, stats, free-plan line
    # and usage reporting) is orchestrated by the shared task runner.
    return run_task(runtime, prompt, {"awaitUsageReport": True, "verbose": is_verbose()})
