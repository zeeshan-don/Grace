"""
Client-side remote provider (port of src/providers/remote.ts).

When the CLI has no local GROQ_API_KEY but the user is logged in, agent runs
are proxied to the GRACE backend (`POST /api/provider`), where the production
provider key lives — it never reaches the CLI. This provider implements the
same `AIProvider` contract as the local Groq provider, so the agent loop and
CLI are unchanged.

The backend proxy is non-streaming today: `stream_chat` buffers the single
response and replays it as stream events.
"""

import requests

from grace.providers.types import ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, Usage, as_chat_messages, as_chat_options

DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_CONTEXT = 131_072


def _message_to_wire(m: ChatMessage) -> dict:
    """JSON-safe wire form of a message: the loop stores tool calls as
    ToolCallParam objects, which must be serialized to plain dicts before the
    request body is encoded."""
    out: dict = {"role": m.role, "content": m.content}
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.tool_calls:
        out["tool_calls"] = [
            {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
            for tc in m.tool_calls
        ]
    if m.name:
        out["name"] = m.name
    return out


class RemoteProviderError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class RemoteProvider:
    id = "remote"
    label = "GRACE backend"

    # Module-level shared view of the freshest server state (role routing
    # creates several RemoteProvider instances per run against the same
    # backend, so the most recent response's session/provider facts are made
    # visible to the CLI regardless of which instance received it).
    _shared_session = None
    _shared_server_provider = None

    def __init__(self, api_url: str, token: str, model: str | None = None, tier: str | None = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.api_url = api_url.rstrip("/")
        self.token = token
        # NVIDIA-first default; the server verifies it against its live catalog.
        self.model_id = model or "openai/gpt-oss-20b"
        self.tier = tier
        self.timeout_ms = timeout_ms
        self.session_info = None
        self.server_provider_info = None

    @property
    def model_tier(self) -> str | None:
        return self.tier

    def with_model(self, model: str, tier: str | None = None) -> "RemoteProvider":
        """A copy of this provider pinned to a different model + tier."""
        return RemoteProvider(api_url=self.api_url, token=self.token, model=model, tier=tier, timeout_ms=self.timeout_ms)

    @property
    def last_session(self):
        return self.session_info

    @staticmethod
    def shared_session():
        return RemoteProvider._shared_session

    @staticmethod
    def set_shared_session(state):
        RemoteProvider._shared_session = state

    @staticmethod
    def shared_server_provider():
        return RemoteProvider._shared_server_provider

    @property
    def server_provider(self):
        return self.server_provider_info

    def get_model(self) -> ModelInfo:
        return ModelInfo(id=self.model_id, contextWindow=DEFAULT_CONTEXT, supportedFeatures=["tool_calls", "json"])

    def set_model(self, model_id: str) -> None:
        self.model_id = model_id

    def list_models(self) -> list[str]:
        # Model discovery stays server-side; the backend selects from its own list.
        return []

    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult:
        messages = as_chat_messages(messages)
        data = self._post(messages, as_chat_options(options))
        if data and data.get("session"):
            self.session_info = data["session"]
            RemoteProvider._shared_session = data["session"]
        if data and data.get("provider_id"):
            info = {"id": data["provider_id"], "label": data.get("provider_label") or data["provider_id"]}
            self.server_provider_info = info
            RemoteProvider._shared_server_provider = info
        return ChatResult(
            content=data.get("content") if data else None,
            toolCalls=[ToolCallParam(**tc) for tc in (data.get("tool_calls") or [])] if data else [],
            usage=Usage(**data["usage"]) if data and data.get("usage") else None,
            finishReason=data.get("finish_reason", "stop") if data else "stop",
        )

    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None):
        # Buffered stream: the backend proxy is non-streaming (single JSON).
        result = self.chat(messages, options)
        if result.content:
            yield StreamEvent(type="content", content=result.content)
        for index, tc in enumerate(result.toolCalls):
            yield StreamEvent(type="tool_call_delta", index=index, id=tc.id, name=tc.name, argumentsDelta=tc.arguments)
        yield StreamEvent(type="done", usage=result.usage)

    # -------------------------------------------------------------------------

    def _post(self, messages: list[ChatMessage], options: ChatOptions) -> dict | None:
        body: dict = {
            "messages": [_message_to_wire(m) for m in messages],
            "model": self.model_id,
            "temperature": options.temperature if options.temperature is not None else 0.2,
        }
        if self.tier:
            body["tier"] = self.tier
        if options.maxTokens is not None:
            body["maxTokens"] = options.maxTokens
        if options.tools:
            body["tools"] = [t.__dict__ for t in options.tools]

        try:
            res = requests.post(
                f"{self.api_url}/api/provider",
                json=body,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
                timeout=self.timeout_ms / 1000,
            )
        except requests.exceptions.Timeout:
            raise RemoteProviderError(0, "The request timed out. Check your connection and ZEESH_API_URL (the local backend runs with `python -m grace.server.serve`).")
        except requests.exceptions.RequestException:
            raise RemoteProviderError(0, f"Could not reach {self.api_url}. Check your connection and ZEESH_API_URL (the local backend runs with `python -m grace.server.serve`).")

        try:
            data = res.json()
        except Exception:
            data = None

        if not res.ok:
            # Even a rejection (e.g. 429 daily_limit_exhausted) may carry the current
            # session state, so the CLI can still render the quota.
            if res.status_code == 429 and isinstance(data, dict) and data.get("session"):
                self.session_info = data["session"]
                RemoteProvider._shared_session = data["session"]
            raise RemoteProviderError(res.status_code, self._describe_error(res.status_code, data))

        if data is None:
            raise RemoteProviderError(res.status_code, "The GRACE backend returned an invalid response.")
        if not isinstance(data, dict):
            raise RemoteProviderError(res.status_code, "The GRACE backend returned an invalid response.")
        return data

    def _describe_error(self, status: int, data) -> str:
        if isinstance(data, dict):
            error = data.get("error")
            code = data.get("code")
        else:
            error, code = None, None
        if status == 401:
            return 'Your GRACE session is invalid or expired — run "grace login" again.'
        if status == 429:
            if code in ("daily_limit_exhausted", "daily_cost_exhausted", "global_cost_exhausted"):
                # The server's message is the authoritative, user-safe text.
                return error or "Grace has reached today's usage capacity. Please try again after the daily reset."
            return "The GRACE backend rate limit was hit — wait a moment and retry."
        if error:
            return f"{error} (status {status})"
        return f"The GRACE backend returned status {status}."
