"""Configuration and environment loading (port of src/config/config.ts).

Environment precedence mirrors the TS version:
  1. process env (always wins — dotenv never overrides existing vars),
  2. `<project>/.env`,
  3. `~/.zeesh/env`.
"""

import json
import os
import shutil
import stat
from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

# Default model candidates (NVIDIA-first — GRACE's primary provider).
DEFAULT_MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
]

CONFIG_DIR = Path.home() / ".zeesh"
CONFIG_PATH = CONFIG_DIR / "config.json"


def homedir() -> str:
    return str(Path.home())


# ---------------------------------------------------------------------------
# One-time migration from legacy ~/.myagent (pre-rename)
# ---------------------------------------------------------------------------


def migrate_legacy_config() -> None:
    """Copy the legacy `~/.myagent/` directory into `~/.zeesh/` when the new
    directory does not exist yet. Copy-only and idempotent — never deletes."""
    try:
        legacy = Path.home() / ".myagent"
        if not legacy.exists() or CONFIG_DIR.exists():
            return
        entries = [p for p in legacy.iterdir()]
        if not entries:
            return
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _copy_tree(legacy, CONFIG_DIR)
    except Exception:
        # Best-effort — never break the CLI over a failed migration.
        pass


def _copy_tree(src: Path, dst: Path) -> None:
    for entry in src.iterdir():
        target = dst / entry.name
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy_tree(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)
            try:
                os.chmod(target, stat.S_IMODE(entry.stat().st_mode))
            except Exception:
                pass


# ---------------------------------------------------------------------------
# .env loading (minimal dotenv, mirrors `dotenv.config({ quiet: true })`)
# ---------------------------------------------------------------------------


def _load_dotenv_file(path: Path) -> None:
    """Parse a .env file into os.environ without overriding existing vars."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def load_env(project_root: str) -> None:
    """Load configuration into os.environ (never exposes values to the model):
    1. `~/.zeesh/env` — the user's zeesh-level secrets
    2. `<project>/.env`  — the project's own environment
    Process-level env vars always take precedence.
    """
    _load_dotenv_file(CONFIG_DIR / "env")
    _load_dotenv_file(Path(project_root) / ".env")


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


def groq_api_key() -> str | None:
    key = os.environ.get("GROQ_API_KEY", "").strip()
    return key if key else None


# Production GRACE backend the CLI logs in to and reports usage to.
# Canonical domain (grace.zeeshstudios.in); the legacy .vercel.app domain
# 307-redirects to it, which drops the Authorization header on redirect, so the
# CLI talks to the canonical domain directly.
PRODUCTION_API_URL = "https://grace.zeeshstudios.in"

# Local dev backend — used only when explicitly selected (local development).
LOCAL_API_URL = "http://localhost:8787"

# Default GRACE backend URL used by login/usage-reporting when unset.
DEFAULT_API_URL = PRODUCTION_API_URL


def is_local_backend(url: str) -> bool:
    """True when the resolved backend is the local dev server (explicit opt-in)."""
    u = url.strip().lower()
    return u == LOCAL_API_URL or u == "http://127.0.0.1:8787" or _is_localhost_url(u)


def _is_localhost_url(u: str) -> bool:
    if not u.startswith(("http://", "https://")):
        return False
    rest = u.split("://", 1)[1]
    host = rest.split("/", 1)[0].split(":", 1)[0].lower()
    return host == "localhost" or host == "127.0.0.1"


def zeesh_api_url() -> str:
    """The GRACE backend the CLI authenticates against (env override)."""
    return os.environ.get("ZEESH_API_URL", "").strip() or DEFAULT_API_URL


def load_app_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_app_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def resolve_model(cli_model: str | None, cfg: dict) -> str:
    """Resolve the effective model id: CLI flag > saved config > default."""
    if cli_model:
        return cli_model
    if cfg.get("model"):
        return cfg["model"]
    return DEFAULT_MODELS[0]


def ensure_dir(p: str) -> None:
    Path(p).mkdir(parents=True, exist_ok=True)
