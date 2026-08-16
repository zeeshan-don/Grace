"""MiniMax provider (port of src/providers/minimax.ts) — OpenAI-compatible Chat Completions API."""

import random
import string

import requests

from grace.providers.errors import ProviderError, scrub
from grace.providers.types import ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, Usage, as_chat_messages, as_chat_options

MINIMAX_BASE_URL = "https://api.minimax.io/v1"
DEFAULT_MINIMAX_MODEL = "MiniMax-M3"
DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_CONTEXT = 1_000_000


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
        cachedInputTokens=(u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0,
    )


def cached_input_tokens(u: dict | None) -> int:
    return ((u or {}).get("prompt_tokens_details") or {}).get("cached_tokens") or 0


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
    err = data or {}
    msg = err.get("error", {}).get("message") or (err.get("base_resp") or {}).get("status_msg") or ""
    code = (err.get("base_resp") or {}).get("status_code") or 0
    is_quota = bool(__import__("re").search(r"quota|exhausted|balance|insufficient", msg, __import__("re").I))
    is_rate = bool(__import__("re").search(r"rate.?limit|too many|frequency", msg, __import__("re").I))
    if status in (401, 403) or code == 1004:
        return "authentication"
    if status == 429 or is_rate:
        return "quota_exhausted" if is_quota else "rate_limit"
    if status == 404:
        return "unavailable_model"
    if status == 408:
        return "timeout"
    if status >= 500:
        return "server_error"
    if is_quota:
        return "quota_exhausted"
    return "unknown"


class MiniMaxProvider:
    id = "minimax"
    label = "MiniMax"

    def __init__(self, api_key: str, model: str | None = None, base_url: str | None = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.api_key = api_key
        self.base_url = (base_url or MINIMAX_BASE_URL).rstrip("/")
        self.model_id = model or DEFAULT_MINIMAX_MODEL
        self.timeout_ms = timeout_ms

    def get_model(self) -> ModelInfo:
        return ModelInfo(
            id=self.model_id,
            contextWindow=DEFAULT_CONTEXT,
            supportedFeatures=["tool_calls", "json", "streaming"],
        )

    def set_model(self, model_id: str) -> None:
        self.model_id = model_id

    def list_models(self) -> list[str]:
        try:
            res = requests.get(f"{self.base_url}/models", headers={"Authorization": f"Bearer {self.api_key}"}, timeout=min(self.timeout_ms, 10_000) / 1000)
            if not res.ok:
                return []
            data = res.json()
            return sorted(m.get("id", "") for m in (data.get("data") or []))
        except Exception:
            return []

    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult:
        messages = as_chat_messages(messages)
        options = as_chat_options(options)
        body: dict = {
            "model": self.model_id,
            "messages": _to_wire(messages),
            "temperature": options.temperature if options.temperature is not None else 0.2,
            # reasoning_split keeps <think> blocks out of content (tool-call safe).
            "reasoning_split": True,
        }
        if options.maxTokens is not None:
            body["max_completion_tokens"] = options.maxTokens
        if options.tools:
            body["tools"] = [t.__dict__ for t in options.tools]

        data = self._post(body, options)
        choice = (data.get("choices") or [{}])[0]
        if not choice:
            raise ProviderError(self.id, "malformed_response", "MiniMax returned no completion choices.", 200)
        msg = choice.get("message") or {}
        return ChatResult(
            content=msg.get("content"),
            toolCalls=_from_wire_tool_calls(msg.get("tool_calls") or []),
            usage=_to_usage(data.get("usage")),
            finishReason=choice.get("finish_reason") or "stop",
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
                f"{self.base_url}/chat/completions",
                json=body,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout_ms / 1000,
            )
        except requests.exceptions.Timeout:
            raise ProviderError(self.id, "timeout", "MiniMax request timed out.")
        except requests.exceptions.RequestException:
            raise ProviderError(self.id, "network", "Could not reach the MiniMax API.")

        data = None
        try:
            data = res.json()
        except Exception:
            data = None

        if not res.ok:
            raw = ((data or {}).get("error") or {}).get("message") or ""
            raise ProviderError(self.id, _classify_failure(res.status_code, data), scrub(raw) or "MiniMax request failed.", res.status_code)
        if data is None:
            raise ProviderError(self.id, "malformed_response", "MiniMax returned an unparseable response.", res.status_code)
        # MiniMax can return HTTP 200 with a business-level error (base_resp).
        code = ((data.get("base_resp") or {}).get("status_code")) or 0
        if code != 0:
            detail = scrub((data.get("base_resp") or {}).get("status_msg") or f"MiniMax error {code}")
            raise ProviderError(self.id, _classify_failure(200, data), detail, 200)
        return data
