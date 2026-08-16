"""
Task-run error taxonomy (agent loop) — port of src/agent/errors.ts.

The loop classifies every failure into one of these categories so the UI
reports the ACTUAL failure (an invalid tool call is not a provider outage).
All messages are scrubbed before they reach the session/UI — never a raw
SDK error that could echo an API key.
"""

import re

from grace.providers.errors import scrub

TASK_ERROR_LABELS = {
    "provider_unavailable": "Provider unavailable",
    "provider_timeout": "Provider timeout",
    "provider_authentication": "Provider authentication error",
    "invalid_tool_call": "Invalid tool call",
    "tool_execution": "Tool execution error",
    "task_cancelled": "Task cancelled",
}


def describe_run_error_category(category: str) -> str:
    return {
        "provider_unavailable": "The AI provider could not be reached.",
        "provider_timeout": "The AI provider timed out.",
        "provider_authentication": "The AI provider rejected the request (authentication failed).",
        "invalid_tool_call": "The agent received malformed arguments for a tool call and could not safely execute it.",
        "tool_execution": "A tool failed while executing.",
        "task_cancelled": "The task was cancelled.",
    }.get(category, "The task could not be completed.")


def classify_provider_error(message: str) -> str:
    """Classify a raw provider error message into the taxonomy."""
    m = message.lower()
    if re.search(r"timed? ?out|timeout|etimedout|408|504|deadline exceeded", m):
        return "provider_timeout"
    if re.search(r"401|403|authentication|unauthorized|invalid api key|incorrect api key|api key.*(invalid|rejected)", m, re.I):
        return "provider_authentication"
    return "provider_unavailable"


def provider_error(message: str, provider: dict) -> dict:
    """Build a scrubbed TaskRunError from a raw provider error message."""
    return {
        "category": classify_provider_error(message),
        "message": scrub(message),
        "providerId": provider["id"],
        "providerLabel": provider["label"],
        "modelId": provider["modelId"],
    }


def format_run_error(error: dict) -> str:
    parts = [describe_run_error_category(error["category"])]
    if error.get("message"):
        parts.append(error["message"])
    return "\n".join(parts)
