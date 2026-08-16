"""Provider factory (port of src/providers/registry.ts)."""

from grace.providers.deepseek import DeepSeekProvider
from grace.providers.gemini import GeminiProvider
from grace.providers.groq import GroqProvider
from grace.providers.minimax import MiniMaxProvider
from grace.providers.nvidia import NvidiaProvider

SUPPORTED_PROVIDERS = ["groq", "nvidia", "deepseek", "gemini", "minimax"]


def create_provider(provider_id: str, api_key: str, model: str | None = None):
    """Create an AI provider by id."""
    if provider_id == "groq":
        return GroqProvider(api_key=api_key, model=model)
    if provider_id == "nvidia":
        return NvidiaProvider(api_key=api_key, model=model)
    if provider_id == "deepseek":
        return DeepSeekProvider(api_key=api_key, model=model)
    if provider_id == "gemini":
        return GeminiProvider(api_key=api_key, model=model)
    if provider_id == "minimax":
        return MiniMaxProvider(api_key=api_key, model=model)
    raise ValueError(
        f'Unknown provider "{provider_id}". Implemented: groq, nvidia, deepseek, gemini, minimax.'
    )
