"""Runtime (port of src/runtime.ts).

Bundles the per-workspace state the CLI and coordinator need: the resolved
provider, project info, persistent session, undo store and tool set.
"""

import os

from grace.agents.model_router import is_known_model, pick_model_for_provider
from grace.auth.session import clear_session, load_session, session_expired
from grace.config import groq_api_key, load_app_config, resolve_model
from grace.git import is_git_repo
from grace.project.detect import detect_project
from grace.providers.registry import create_provider
from grace.providers.remote import RemoteProvider
from grace.session.session import Session
from grace.session.undo import UndoStore
from grace.tools.registry import ToolContext, create_tools

NO_PROVIDER_MESSAGE = (
    'No AI provider configured — add GROQ_API_KEY to .env or run "grace login" to use the GRACE backend. '
    "Slash commands still work."
)


def ensure_state_dir_ignore(root: str) -> None:
    """Keep the agent's own state out of the user's git repo (best-effort)."""
    if not is_git_repo(root):
        return
    gitignore_path = os.path.join(root, ".gitignore")
    entry = ".zeesh/"
    legacy_entry = ".myagent/"
    try:
        if os.path.exists(gitignore_path):
            with open(gitignore_path, encoding="utf-8") as f:
                content = f.read()
            lines = [line.strip() for line in content.splitlines()]
            additions = []
            if entry.strip() not in lines:
                additions.append(entry)
            if legacy_entry.strip() not in lines:
                additions.append(legacy_entry)
            if additions:
                with open(gitignore_path, "a", encoding="utf-8") as f:
                    if content and not content.endswith("\n"):
                        f.write("\n")
                    f.write("\n".join(additions) + "\n")
        else:
            with open(gitignore_path, "w", encoding="utf-8") as f:
                f.write(entry + "\n" + legacy_entry + "\n")
    except Exception:
        # best-effort
        pass


def resolve_provider(key: str | None, model: str, session: dict | None) -> dict:
    """Pick the AI provider for a run:
      1. a local GROQ_API_KEY wins (offline/self-hosted usage),
      2. otherwise a valid login session proxies model calls through the GRACE
         backend (`POST /api/provider`) so production keys stay server-side.
    """
    if key:
        try:
            # The local Groq path only ever serves Groq models: a documented
            # NVIDIA-only id (e.g. the NVIDIA-first default) is substituted with
            # the Groq coding default so a local key never targets an unserved
            # model. Unknown/custom ids are passed through (the provider validates).
            if is_known_model("groq", model) or not is_known_model("nvidia", model):
                local_model = model
            else:
                local_model = pick_model_for_provider("groq", "coding")
            return {"provider": create_provider("groq", key, local_model), "error": None}
        except Exception as err:
            return {"provider": None, "error": str(err)}
    if session and not session_expired(session):
        return {"provider": RemoteProvider(api_url=session["apiUrl"], token=session["token"], model=model), "error": None}
    return {"provider": None, "error": NO_PROVIDER_MESSAGE}


class Runtime:
    def __init__(self, root: str, yes: bool = False, model: str | None = None, ask=None) -> None:
        self.root = root
        cfg = load_app_config()
        self.model = resolve_model(model, cfg)
        self.project = detect_project(root)
        ensure_state_dir_ignore(root)
        self.session = Session(root)
        self.undo = UndoStore(root)

        key = groq_api_key()
        stored = load_session()
        if stored and session_expired(stored):
            clear_session()  # don't keep stale credentials around

        resolution = resolve_provider(key, self.model, stored)
        self.provider = resolution["provider"]
        self.provider_error = resolution["error"]

        self.yes = yes
        self.ask = ask or self._default_ask

        ctx = ToolContext(projectRoot=root, askPermission=self.ask, undo=self.undo)
        self.tools = create_tools(ctx)

    def _default_ask(self, command: str, reasons: list[str]) -> bool:
        """Fallback permission prompt (used in one-shot mode when stdin is a TTY)."""
        try:
            import sys

            if not (sys.stdin.isatty() and sys.stdout.isatty()):
                return False  # piped/CI → deny by default
            answer = input(
                f"\nThe agent wants to run:\n\n  {command}\n\nFlagged: {'; '.join(reasons)}\n\nAllow? [y/N] "
            )
            return answer.strip().lower().startswith("y")
        except (EOFError, KeyboardInterrupt):
            return False


def create_runtime(root: str, opts: dict | None = None) -> Runtime:
    opts = opts or {}
    return Runtime(
        root,
        yes=opts.get("yes", False),
        model=opts.get("model"),
        ask=opts.get("ask"),
    )
