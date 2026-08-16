"""In-memory conversation store for subagents (port of src/session/memory.ts)."""

EMPTY_STATS = {"runs": 0, "toolCalls": 0, "inputTokens": 0, "outputTokens": 0}


class MemorySession:
    """
    In-memory conversation store used by coordinator subagents.

    Deliberately never touches disk: a subagent run (scout, picker, reviewer,
    test runner, …) must not pollute the user's real `.zeesh/session.json`
    history. Only the main editor agent uses the persistent `Session`.
    """

    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.toolHistory: list[str] = []
        self.stats: dict = dict(EMPTY_STATS)

    def push_message(self, msg: dict) -> None:
        self.messages.append(msg)

    def record_tool_call(self, description: str) -> None:
        self.toolHistory.append(description)
        self.stats["toolCalls"] += 1

    def begin_run(self) -> None:
        self.stats["runs"] += 1

    def add_usage(self, input_tokens: int | None, output_tokens: int | None) -> None:
        if input_tokens:
            self.stats["inputTokens"] += input_tokens
        if output_tokens:
            self.stats["outputTokens"] += output_tokens

    def clear(self) -> None:
        self.messages = []
        self.toolHistory = []
        self.stats = dict(EMPTY_STATS)

    def save(self) -> None:
        # no-op — subagent history is ephemeral by design
        pass

    @property
    def message_count(self) -> int:
        return len(self.messages)
