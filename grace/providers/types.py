"""
Provider-agnostic AI interfaces (port of src/providers/types.ts).

The rest of the application only ever talks to `AIProvider`. Groq is the
first implementation; Gemini, NVIDIA, DeepSeek, MiniMax and the remote
backend proxy implement the same contract.
"""

from dataclasses import dataclass, field
from typing import Any, Iterator, Protocol


@dataclass
class ToolCallParam:
    id: str
    name: str
    # Raw JSON string as returned by the model.
    arguments: str


@dataclass
class ChatMessage:
    role: str  # 'system' | 'user' | 'assistant' | 'tool'
    content: str | None = None
    # Set for tool result messages — id of the tool call being answered.
    tool_call_id: str | None = None
    # Set for assistant messages that requested tool calls.
    tool_calls: list[ToolCallParam] | None = None
    # Optional name for tool messages.
    name: str | None = None


@dataclass
class ToolDefinition:
    type: str = "function"
    function: dict[str, Any] = field(default_factory=dict)


@dataclass
class Usage:
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    # Cached/context input tokens (reported by providers that expose them).
    cachedInputTokens: int = 0


@dataclass
class ModelInfo:
    id: str
    # Approximate context window in tokens.
    contextWindow: int
    supportedFeatures: list[str] = field(default_factory=list)


@dataclass
class ChatOptions:
    tools: list[ToolDefinition] | None = None
    temperature: float | None = None
    maxTokens: int | None = None
    # Abort signal forwarded to the underlying HTTP client.
    signal: Any = None


@dataclass
class ChatResult:
    content: str | None = None
    toolCalls: list[ToolCallParam] = field(default_factory=list)
    usage: Usage | None = None
    finishReason: str = "stop"


@dataclass
class StreamEvent:
    type: str  # 'content' | 'tool_call_delta' | 'done'
    content: str | None = None
    index: int = 0
    id: str | None = None
    name: str | None = None
    argumentsDelta: str | None = None
    usage: Usage | None = None


def as_chat_options(options) -> ChatOptions:
    """Coerce a plain-dict options object (as passed by the agent loop) into a
    ChatOptions instance before it reaches a provider."""
    if isinstance(options, ChatOptions):
        return options
    if isinstance(options, dict):
        return ChatOptions(**{k: v for k, v in options.items() if k in ChatOptions.__dataclass_fields__})
    return options or ChatOptions()


def as_chat_messages(messages: list) -> list[ChatMessage]:
    """Coerce plain-dict messages (as stored in the session) into ChatMessage
    objects before they reach a provider's wire encoder. Dicts are the loop's
    internal representation; providers only ever see ChatMessage."""
    out: list[ChatMessage] = []
    for m in messages:
        if isinstance(m, ChatMessage):
            out.append(m)
        elif isinstance(m, dict):
            tool_calls = m.get("tool_calls")
            out.append(ChatMessage(
                role=m.get("role") or "",
                content=m.get("content"),
                tool_call_id=m.get("tool_call_id"),
                tool_calls=[tc if isinstance(tc, ToolCallParam) else ToolCallParam(**tc) for tc in tool_calls] if tool_calls else None,
                name=m.get("name"),
            ))
        else:
            out.append(m)
    return out


class AIProvider(Protocol):
    """Provider-agnostic contract implemented by every provider."""

    id: str
    label: str

    def get_model(self) -> ModelInfo: ...
    def set_model(self, model_id: str) -> None: ...
    def list_models(self) -> list[str]: ...
    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult: ...
    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> Iterator[StreamEvent]: ...
