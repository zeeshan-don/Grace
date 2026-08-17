"""Groq provider (port of src/providers/groq.ts) — OpenAI-compatible API via requests."""

import json

import requests

from grace.providers.types import (
    ChatMessage,
    ChatOptions,
    ChatResult,
    ModelInfo,
    StreamEvent,
    ToolCallParam,
    Usage,
    as_chat_messages,
    as_chat_options,
)
from grace.util_text import estimate_tokens

GROQ_BASE_URL = "https://api.groq.com/openai/v1"

DEFAULT_CONTEXT = 128_000
KNOWN_CONTEXTS = {
    "llama-3.1-8b-instant": 131_072,
    "llama-3.3-70b-versatile": 131_072,
    "openai/gpt-oss-120b": 131_072,
    "openai/gpt-oss-20b": 131_072,
    "qwen/qwen3.6-27b": 131_072,
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


def _from_wire_tool_calls(tcs: list[dict]) -> list[ToolCallParam]:
    return [
        ToolCallParam(id=tc.get("id", ""), name=tc.get("function", {}).get("name", ""), arguments=tc.get("function", {}).get("arguments") or "{}")
        for tc in tcs
    ]


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


class GroqProvider:
    id = "groq"
    label = "Groq (LPU)"

    def __init__(self, api_key: str, model: str | None = None, base_url: str | None = None, timeout_ms: int = 60_000) -> None:
        self.api_key = api_key
        self.base_url = (base_url or GROQ_BASE_URL).rstrip("/")
        self.timeout_ms = timeout_ms
        self.model_id = model or "openai/gpt-oss-120b"
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
        data = self._post(f"{self.base_url}/chat/completions", body, options)
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        return ChatResult(
            content=msg.get("content"),
            toolCalls=_from_wire_tool_calls(msg.get("tool_calls") or []),
            usage=_to_usage(data.get("usage")),
            finishReason=choice.get("finish_reason") or "stop",
        )

    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None):
        """SSE stream (Groq reports usage via x_groq on the final chunk; we estimate instead)."""
        messages = as_chat_messages(messages)
        options = as_chat_options(options)
        body: dict = {
            "model": self.model_id,
            "messages": _to_wire(messages),
            "temperature": options.temperature if options.temperature is not None else 0.2,
            "max_tokens": options.maxTokens if options.maxTokens is not None else 4096,
            "stream": True,
        }
        if options.tools:
            body["tools"] = [t.__dict__ for t in options.tools]

        output_chars = 0
        with requests.post(
            f"{self.base_url}/chat/completions",
            json=body,
            headers={"Authorization": f"Bearer {self.api_key}"},
            stream=True,
            timeout=self.timeout_ms / 1000,
        ) as res:
            if not res.ok:
                raise self._error_from_response(res)
            for raw in res.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                if raw.startswith("data:"):
                    payload = raw[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except Exception:
                        continue
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        output_chars += len(delta["content"])
                        yield StreamEvent(type="content", content=delta["content"])
                    for tc in delta.get("tool_calls") or []:
                        yield StreamEvent(
                            type="tool_call_delta",
                            index=tc.get("index", 0),
                            id=tc.get("id"),
                            name=tc.get("function", {}).get("name"),
                            argumentsDelta=tc.get("function", {}).get("arguments"),
                        )

        input_tokens = estimate_tokens(json.dumps(_to_wire(messages)))
        output_tokens = max(1, (output_chars + 3) // 4)
        yield StreamEvent(type="done", usage=Usage(inputTokens=input_tokens, outputTokens=output_tokens, totalTokens=input_tokens + output_tokens))

    # -------------------------------------------------------------------------

    def _post(self, url: str, body: dict, options: ChatOptions) -> dict:
        try:
            res = requests.post(url, json=body, headers={"Authorization": f"Bearer {self.api_key}"}, timeout=self.timeout_ms / 1000)
        except requests.exceptions.Timeout:
            from grace.providers.errors import ProviderError
            raise ProviderError(self.id, "timeout", "Groq request timed out.")
        except requests.exceptions.RequestException:
            from grace.providers.errors import ProviderError
            raise ProviderError(self.id, "network", "Could not reach Groq.")
        if not res.ok:
            raise self._error_from_response(res)
        try:
            return res.json()
        except Exception:
            from grace.providers.errors import ProviderError
            raise ProviderError(self.id, "malformed_response", "Groq returned an unparseable response.", res.status_code)

    def _error_from_response(self, res: requests.Response):
        from grace.providers.errors import ProviderError, scrub
        try:
            data = res.json()
            raw = (data.get("error") or {}).get("message") or ""
        except Exception:
            raw = ""
        status = res.status_code
        category = self._classify_failure(status, raw)
        return ProviderError(self.id, category, scrub(raw) or "Groq request failed.", status)

    @staticmethod
    def _classify_failure(status: int, msg: str) -> str:
        if status in (401, 403):
            return "authentication"
        if status == 429:
            return "rate_limit"
        if status == 408:
            return "timeout"
        if status == 404:
            return "unavailable_model"
        if status >= 500:
            return "server_error"
        if "rate" in msg.lower() or "limit" in msg.lower() or "too large" in msg.lower():
            return "rate_limit"
        return "unknown"
