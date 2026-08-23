"""Steering messages (port of packages/agent-runtime/src/run-agent-step.ts drainSteeringMessages).

Steering allows the user to send additional messages to a running agent
WITHOUT cancelling the current task. The messages are buffered and injected
into the conversation at the next step boundary (after the current tool
calls complete, before the next LLM call).

This is useful when:
  - The agent is working and the user wants to refine the request
  - The user wants to provide additional context mid-task
  - The user wants to redirect the agent without losing progress

Implementation:
  - A thread-safe queue holds pending steering messages.
  - The agent loop checks the queue at each step boundary.
  - Injected messages appear as user prompts in the conversation.
"""

from __future__ import annotations

import threading
from collections import deque


class SteeringQueue:
    """Thread-safe buffer for user messages sent to a running agent."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._messages: deque[str] = deque()
        self._drained: list[str] = []

    def push(self, text: str) -> None:
        """Add a steering message (called from the UI thread)."""
        with self._lock:
            self._messages.append(text)

    def drain(self) -> list[str]:
        """Drain all pending messages (called from the agent worker thread at step boundaries).

        Returns the list of messages that were pending. The agent loop should
        inject these as user prompts and keep the turn going.
        """
        with self._lock:
            drained = list(self._messages)
            self._messages.clear()
            self._drained = drained
            return drained

    @property
    def has_pending(self) -> bool:
        with self._lock:
            return len(self._messages) > 0

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._messages)

    def peek(self) -> list[str]:
        """Look at pending messages without draining them."""
        with self._lock:
            return list(self._messages)

    def clear(self) -> None:
        """Clear all pending messages."""
        with self._lock:
            self._messages.clear()
            self._drained.clear()
