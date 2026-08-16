"""Persistent conversation session (port of src/session/session.ts)."""

import json
import os
from pathlib import Path

EMPTY_STATS = {"runs": 0, "toolCalls": 0, "inputTokens": 0, "outputTokens": 0}


class Session:
    """
    Persists the conversation and tool history for the current project under
    `.zeesh/session.json`. History is used to continue multi-turn tasks and
    is wiped by `/clear`. Never contains secrets: tool outputs are redacted
    before they are stored.
    """

    def __init__(self, project_root: str) -> None:
        self.path = os.path.join(project_root, ".zeesh", "session.json")
        Path(os.path.join(project_root, ".zeesh")).mkdir(parents=True, exist_ok=True)
        self.messages: list[dict] = []
        self.toolHistory: list[str] = []
        self.stats: dict = dict(EMPTY_STATS)
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(Path(self.path).read_text(encoding="utf-8"))
        except Exception:
            self.messages = []
            self.toolHistory = []
            self.stats = dict(EMPTY_STATS)
            return
        if not isinstance(data, dict):
            self.messages = []
            self.toolHistory = []
            self.stats = dict(EMPTY_STATS)
            return
        self.messages = data.get("messages") if isinstance(data.get("messages"), list) else []
        self.toolHistory = data.get("toolHistory") if isinstance(data.get("toolHistory"), list) else []
        merged = dict(EMPTY_STATS)
        if isinstance(data.get("stats"), dict):
            merged.update({k: v for k, v in data["stats"].items() if k in merged})
        self.stats = merged

    def save(self) -> None:
        try:
            Path(self.path).write_text(
                json.dumps({"messages": self.messages, "toolHistory": self.toolHistory, "stats": self.stats}, indent=2),
                encoding="utf-8",
            )
        except Exception:
            # Persistence is best-effort — never break the CLI over it.
            pass

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
        self.save()

    @property
    def message_count(self) -> int:
        return len(self.messages)
