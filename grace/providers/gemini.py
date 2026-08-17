"""Gemini provider (port of src/providers/gemini.ts) — Google Generative Language API via requests."""

import json

import requests

from grace.providers.errors import ProviderError, scrub
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

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_CONTEXT = 1_048_576
KNOWN_CONTEXTS = {
    "gemini-3.1-flash-lite": 1_048_576,
    "gemini-3.1-flash-lite-preview": 1_048_576,
    "gemini-2.5-flash-lite": 1_048_576,
}


def _parse_args(raw: str) -> dict:
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _tool_result_to_struct(content: str) -> dict:
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {"result": content}


def _to_gemini(messages: list[ChatMessage]) -> tuple[str, list[dict]]:
    systems: list[str] = []
    contents: list[dict] = []
    for m in messages:
        if m.role == "system":
            if m.content:
                systems.append(m.content)
            continue
        parts: list[dict] = []
        if m.role == "assistant":
            if m.content:
                parts.append({"text": m.content})
            for tc in m.tool_calls or []:
                parts.append({"functionCall": {"name": tc.name, "args": _parse_args(tc.arguments)}})
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if m.role == "tool":
            name = m.name or "tool"
            contents.append({"role": "user", "parts": [{"functionResponse": {"name": name, "response": _tool_result_to_struct(m.content or "")}}]})
            continue
        # user
        if m.content:
            contents.append({"role": "user", "parts": [{"text": m.content}]})
    return "\n\n".join(systems), _merge_consecutive(contents)


def _merge_consecutive(contents: list[dict]) -> list[dict]:
    out: list[dict] = []
    for c in contents:
        if out and out[-1]["role"] == c["role"]:
            out[-1]["parts"] = out[-1]["parts"] + c["parts"]
        else:
            out.append({"role": c["role"], "parts": list(c["parts"])})
    return out


def _to_usage(u: dict | None) -> Usage | None:
    if not u:
        return None
    input_tokens = u.get("promptTokenCount") or 0
    output_tokens = u.get("candidatesTokenCount") or 0
    cached = u.get("cachedContentTokenCount") or 0
    return Usage(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=u.get("totalTokenCount") or input_tokens + output_tokens,
        cachedInputTokens=cached,
    )


def cached_input_tokens(u: dict | None) -> int:
    return (u or {}).get("cachedContentTokenCount") or 0


def _classify_failure(status: int, data: dict | None) -> str:
    err = (data or {}).get("error") or {}
    msg = err.get("message") or ""
    is_quota = err.get("status") == "RESOURCE_EXHAUSTED" or bool(__import__("re").search(r"quota|exhausted|limit", msg, __import__("re").I))
    if status in (401, 403):
        return "quota_exhausted" if is_quota else "authentication"
    if status == 429:
        return "quota_exhausted" if is_quota else "rate_limit"
    if status == 404:
        return "unavailable_model"
    if status == 408:
        return "timeout"
    if status >= 500:
        return "server_error"
    return "quota_exhausted" if is_quota else "unknown"


class GeminiProvider:
    id = "gemini"
    label = "Gemini"

    def __init__(self, api_key: str, model: str | None = None, base_url: str | None = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.api_key = api_key
        self.base_url = (base_url or GEMINI_BASE_URL).rstrip("/")
        self.model_id = model or DEFAULT_GEMINI_MODEL
        self.timeout_ms = timeout_ms

    def get_model(self) -> ModelInfo:
        return ModelInfo(
            id=self.model_id,
            contextWindow=KNOWN_CONTEXTS.get(self.model_id, DEFAULT_CONTEXT),
            supportedFeatures=["tool_calls", "json", "streaming"],
        )

    def set_model(self, model_id: str) -> None:
        self.model_id = model_id

    def list_models(self) -> list[str]:
        try:
            res = requests.get(f"{self.base_url}/models?pageSize=1000", headers={"x-goog-api-key": self.api_key}, timeout=min(self.timeout_ms, 10_000) / 1000)
            if not res.ok:
                return []
            data = res.json()
            models = [m.get("name", "").replace("models/", "") for m in (data.get("models") or [])]
            return sorted(m for m in models if "gemini" in m)
        except Exception:
            return []

    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult:
        messages = as_chat_messages(messages)
        options = as_chat_options(options)
        system, contents = _to_gemini(messages)
        body: dict = {"contents": contents}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if options.tools:
            body["tools"] = [{"functionDeclarations": [t.function for t in options.tools]}]
        generation_config: dict = {}
        if options.maxTokens is not None:
            generation_config["maxOutputTokens"] = options.maxTokens
        if options.temperature is not None:
            generation_config["temperature"] = options.temperature
        if generation_config:
            body["generationConfig"] = generation_config

        data = self._post(body, options)
        candidate = (data.get("candidates") or [{}])[0]
        if not candidate or not candidate.get("content"):
            raise ProviderError(self.id, "malformed_response", "Gemini returned no completion candidates.", 200)
        tool_calls: list[ToolCallParam] = []
        text = ""
        for index, part in enumerate((candidate.get("content") or {}).get("parts") or []):
            if "text" in part and part["text"] is not None:
                text += part["text"]
            if part.get("functionCall"):
                tool_calls.append(ToolCallParam(
                    id=f"call_{index}",
                    name=part["functionCall"].get("name", ""),
                    arguments=json.dumps(part["functionCall"].get("args") or {}),
                ))
        return ChatResult(
            content=text or None,
            toolCalls=tool_calls,
            usage=_to_usage(data.get("usageMetadata")),
            finishReason=_map_finish_reason(candidate.get("finishReason")),
        )

    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None):
        # Buffered stream: the backend proxy is non-streaming (single JSON).
        result = self.chat(messages, options)
        if result.content:
            yield StreamEvent(type="content", content=result.content)
        for index, tc in enumerate(result.toolCalls):
            yield StreamEvent(type="tool_call_delta", index=index, id=tc.id, name=tc.name, argumentsDelta=tc.arguments)
        yield StreamEvent(type="done", usage=result.usage)

    def _post(self, body: dict, options: ChatOptions) -> dict:
        try:
            res = requests.post(
                f"{self.base_url}/models/{self.model_id}:generateContent",
                json=body,
                headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key},
                timeout=self.timeout_ms / 1000,
            )
        except requests.exceptions.Timeout:
            raise ProviderError(self.id, "timeout", "Gemini request timed out.")
        except requests.exceptions.RequestException:
            raise ProviderError(self.id, "network", "Could not reach the Gemini API.")

        data = None
        try:
            data = res.json()
        except Exception:
            data = None

        if not res.ok:
            raw = ((data or {}).get("error") or {}).get("message") or ""
            raise ProviderError(self.id, _classify_failure(res.status_code, data), scrub(raw) or "Gemini request failed.", res.status_code)
        if data is None:
            raise ProviderError(self.id, "malformed_response", "Gemini returned an unparseable response.", res.status_code)
        return data


def _map_finish_reason(reason: str | None) -> str:
    return {
        "STOP": "stop",
        "MAX_TOKENS": "length",
        "SAFETY": "content_filter",
        "RECITATION": "recitation",
    }.get(reason, (reason or "stop").lower())
