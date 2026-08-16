"""Real model/provider discovery for the TUI (port of src/cli/tui/models.ts).

The model picker only ever lists models that are actually reachable:
  - local Groq key        → the LIVE Groq catalog (provider.list_models),
                            falling back to the documented Groq table.
  - GRACE backend (login) → the documented NVIDIA/Groq/DeepSeek catalog the
                            server-side router serves, plus the shipped
                            defaults.
The provider picker only lists providers that are genuinely configured.
"""

from grace.agents.model_router import all_known_models, pick_model_for_provider
from grace.auth.session import load_session, session_expired
from grace.config import DEFAULT_MODELS, groq_api_key, load_app_config, save_app_config
from grace.providers.remote import RemoteProvider


def serving_provider_id(runtime) -> str | None:
    if getattr(runtime.provider, "id", None) != "remote":
        return getattr(runtime.provider, "id", None)
    served = runtime.provider.server_provider if isinstance(runtime.provider, RemoteProvider) else None
    return (served or {}).get("id")


def _dedupe(ids: list[str]) -> list[str]:
    out: list[str] = []
    for i in ids:
        if i not in out:
            out.append(i)
    return out


def discover_models(runtime) -> list[dict]:
    """The real set of models for the active provider. Never invents models."""
    provider = runtime.provider
    if not provider:
        return []
    current = provider.get_model().id
    served_label = None
    if isinstance(provider, RemoteProvider):
        served_label = (provider.server_provider or RemoteProvider.shared_server_provider() or {}).get("label")

    if provider.id == "groq":
        live = provider.list_models()
        ids = live if live else all_known_models("groq")
    else:
        # Remote/backend: the server-side router serves NVIDIA + Groq (+ DeepSeek).
        ids = [*DEFAULT_MODELS, *all_known_models("nvidia"), *all_known_models("groq"), *all_known_models("deepseek")]

    return [
        {
            "value": m,
            "label": m,
            "hint": f"via {served_label}" if served_label else _hint_for_model(provider, m),
            "current": m == current,
        }
        for m in _dedupe(ids)
    ]


def _hint_for_model(provider, model_id: str) -> str | None:
    if getattr(provider, "id", None) != "groq":
        return None
    if "gpt-oss-120b" in model_id:
        return "fast coding · recommended"
    if "gpt-oss-20b" in model_id:
        return "light & fast"
    if "qwen" in model_id:
        return "coding"
    if "llama" in model_id:
        return "general"
    return None


def discover_providers(runtime) -> list[dict]:
    """Providers that are actually configured (real keys/sessions only)."""
    opts: list[dict] = []
    key = groq_api_key()
    stored = load_session()
    logged_in = stored is not None and not session_expired(stored)

    if key:
        opts.append({
            "value": "groq",
            "label": "Groq (LPU)",
            "hint": "local API key · offline/self-hosted",
            "current": getattr(runtime.provider, "id", None) == "groq",
        })
    if logged_in:
        opts.append({
            "value": "backend",
            "label": "GRACE backend",
            "hint": "Groq → NVIDIA → Gemini → MiniMax · server-side keys",
            "current": getattr(runtime.provider, "id", None) == "remote",
        })
    return opts


def apply_provider_selection(runtime, value: str) -> str | None:
    """Apply a picker selection to the real runtime + persisted config."""
    if value == "groq":
        key = groq_api_key()
        if not key:
            return "No GROQ_API_KEY configured — add it to ~/.zeesh/env or the project .env first."
        from grace.providers.registry import create_provider

        model = pick_model_for_provider("groq", "coding", runtime.model)
        runtime.provider = create_provider("groq", key, model)
        runtime.provider_error = None
        runtime.model = model
        cfg = load_app_config()
        cfg["provider"] = "groq"
        cfg["model"] = model
        save_app_config(cfg)
        return None
    if value == "backend":
        stored = load_session()
        if not stored or session_expired(stored):
            return "Not logged in — run /login first to use the GRACE backend."
        runtime.provider = RemoteProvider(api_url=stored["apiUrl"], token=stored["token"], model=runtime.model)
        runtime.provider_error = None
        cfg = load_app_config()
        cfg["provider"] = "remote"
        cfg["model"] = runtime.model
        save_app_config(cfg)
        return None
    return f'Unknown provider "{value}".'


def apply_model_selection(runtime, model_id: str) -> str | None:
    """Persist a model selection on the active provider. Returns error text or None."""
    provider = runtime.provider
    if not provider:
        return "No AI provider configured."
    try:
        provider.set_model(model_id)
    except Exception as err:
        return str(err)
    runtime.model = model_id
    cfg = load_app_config()
    cfg["provider"] = getattr(runtime.provider, "id", None)
    cfg["model"] = model_id
    save_app_config(cfg)
    return None
