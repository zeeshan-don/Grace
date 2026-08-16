"""NVIDIA NIM provider (port of src/providers/nvidia.ts) — OpenAI-compatible API via requests."""

import json
import random
import string

import requests

from grace.providers.errors import ProviderError, scrub
from grace.providers.types import ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, Usage, as_chat_messages, as_chat_options

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_NVIDIA_MODEL = "openai/gpt-oss-20b"
DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_CONTEXT = 131_072
KNOWN_CONTEXTS = {
    "openai/gpt-oss-20b": 131_072,
    "openai/gpt-oss-120b": 131_072,
    "nvidia/llama-3.3-nemotron-super-49b-v1.5": 131_072,
    "z-ai/glm-5.2": 131_072,
}


def _to_wire(messages: list[ChatMessage]) -> list[dict]:
    out = []
    for m in messages:
        if m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id or "", "content": m.content or ""})
        elif m.role == "assistant" and m.tool_calls:
            out.append({
                "role": "assistant",
                "content": m.content,
                "tool_calls": [
                    {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": tc.arguments}}
                    for tc in m.tool_calls
                ],
            })
        else:
            out.append({"role": m.role, "content": m.content or ""})
    return out


def _to_usage(u: dict | None) -> Usage | None:
    if not u:
        return None
    input_tokens = u.get("prompt_tokens") or 0
    output_tokens = u.get("completion_tokens") or 0
    return Usage(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=u.get("total_tokens") or input_tokens + output_tokens,
    )


def _random_id() -> str:
    return "call_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def _from_wire_tool_calls(tcs: list[dict]) -> list[ToolCallParam]:
    return [
        ToolCallParam(
            id=tc.get("id") or _random_id(),
            name=tc.get("function", {}).get("name") or "unknown",
            arguments=tc.get("function", {}).get("arguments") or "{}",
        )
        for tc in tcs
    ]


def _classify_failure(status: int, data: dict | None) -> str:
    if status in (401, 403):
        return "authentication"
    if status == 429:
        return "rate_limit"
    if status == 408:
        return "timeout"
    err = data or {}
    msg = (err.get("error") or {}).get("message") or err.get("title") or ""
    if status in (404, 410):
        return "unavailable_model"
    if "model" in msg.lower() and ("not found" in msg.lower() or "does not exist" in msg.lower() or "unavailable" in msg.lower() or "end of life" in msg.lower()):
        return "unavailable_model"
    if "not" in msg.lower() and "support" in msg.lower():
        return "unavailable_model"
    if status >= 500:
        return "unavailable_model"
    return "unknown"


class NvidiaProvider:
    id = "nvidia"
    label = "NVIDIA NIM"

    def __init__(self, api_key: str, model: str | None = None, base_url: str | None = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.api_key = api_key
        self.base_url = (base_url or NVIDIA_BASE_URL).rstrip("/")
        self.model_id = model or DEFAULT_NVIDIA_MODEL
        self.timeout_ms = timeout_ms
        self.models_cache: list[str] | None = None

    def get_model(self) -> ModelInfo:
        return ModelInfo(
            id=self.model_id,
            contextWindow=KNOWN_CONTEXTS.get(self.model_id, DEFAULT_CONTEXT),
            supportedFeatures=["tool_calls", "streaming", "json"],
        )

    def set_model(self, model_id: str) -> None:
        self.model_id = model_id
        self.models_cache = None

    def list_models(self) -> list[str]:
        if self.models_cache is not None:
            return self.models_cache
        try:
            res = requests.get(f"{self.base_url}/models", headers={"Authorization": f"Bearer {self.api_key}"}, timeout=min(self.timeout_ms, 10_000) / 1000)
            if not res.ok:
                return []
            data = res.json()
            self.models_cache = sorted(m.get("id", "") for m in (data.get("data") or []))
            return self.models_cache
        except Exception:
            return []

    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult:
        messages = as_chat_messages(messages)
        options = as_chat_options(options)
        body: dict = {
            "model": self.model_id,
            "messages": _to_wire(messages),
            "temperature": options.temperature if options.temperature is not None else 0.2,
            "max_tokens": options.maxTokens if options.maxTokens is not None else 4096,
        }
        if options.tools:
            body["tools"] = [t.__dict__ for t in options.tools]
        data = self._post(body, options)
        choice = (data.get("choices") or [{}])[0]
        if not choice:
            raise ProviderError(self.id, "malformed_response", "NVIDIA NIM returned no completion choices.", 200)
        msg = choice.get("message") or {}
        return ChatResult(
            content=msg.get("content"),
            toolCalls=_from_wire_tool_calls(msg.get("tool_calls") or []),
            usage=_to_usage(data.get("usage")),
            finishReason=choice.get("finish_reason") or "stop",
        )

    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None):
        # Buffered stream: NVIDIA is used server-side where the proxy is non-streaming.
        result = self.chat(messages, options)
        if result.content:
            yield StreamEvent(type="content", content=result.content)
        for index, tc in enumerate(result.toolCalls):
            yield StreamEvent(type="tool_call_delta", index=index, id=tc.id, name=tc.name, argumentsDelta=tc.arguments)
        yield StreamEvent(type="done", usage=result.usage)

    def _post(self, body: dict, options: ChatOptions) -> dict:
        try:
            res = requests.post(
                f"{self.base_url}/chat/completions",
                json=body,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout_ms / 1000,
            )
        except requests.exceptions.Timeout:
            raise ProviderError(self.id, "timeout", "NVIDIA NIM request timed out.")
        except requests.exceptions.RequestException:
            raise ProviderError(self.id, "network", "Could not reach NVIDIA NIM.")

        data = None
        try:
            data = res.json()
        except Exception:
            data = None

        if not res.ok:
            err = data or {}
            raw = (err.get("error") or {}).get("message") or err.get("detail") or err.get("title") or ""
            raise ProviderError(self.id, _classify_failure(res.status_code, data), scrub(str(raw)) or "NVIDIA NIM request failed.", res.status_code)
        if data is None:
            raise ProviderError(self.id, "malformed_response", "NVIDIA NIM returned an unparseable response.", res.status_code)
        return data
