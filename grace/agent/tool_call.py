"""
Tool-call argument validation (port of src/agent/toolCall.ts).

Model tool calls arrive as a JSON string. Streaming deltas are concatenated
and small models occasionally emit malformed JSON (stray prose, code fences,
truncated objects). This module:

 1. validates arguments BEFORE execution,
 2. applies only UNAMBIGUOUS, conservative repairs (code-fence stripping,
    extracting a single complete JSON object) — it never guesses,
 3. fails safely with a `ToolCallParseError` carrying sanitized diagnostics,
 4. provides `sanitize_arguments_for_wire` so malformed arguments never reach
    the provider's wire format.
"""

import json
import re

from grace.safety import redact_secrets

MAX_DIAG_CHARS = 400


class ToolCallParseError(Exception):
    def __init__(self, message: str, raw_arguments: str) -> None:
        super().__init__(message)
        self.rawArguments = raw_arguments


def sanitize_raw_for_log(raw: str) -> str:
    """Redact secrets + truncate raw arguments before they are logged or shown."""
    return redact_secrets(raw)[:MAX_DIAG_CHARS]


def _try_parse(raw: str):
    """Strict parse: only a JSON object is acceptable (arrays/strings/numbers are not)."""
    try:
        value = json.loads(raw)
    except Exception:
        return None
    if value is None or not isinstance(value, dict):
        return None
    return value


def _extract_balanced_object(text: str) -> str | None:
    """Extract the FIRST balanced JSON object from a string. Returns None when
    the object is incomplete OR when non-whitespace follows it."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    i = start
    while i < len(text):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                if text[i + 1:].strip() == "":
                    return candidate
                return None  # trailing content — ambiguous, do not guess
        i += 1
    return None  # unterminated object — truncated


def _repair(raw: str) -> str | None:
    """Conservative repair; returns None when nothing unambiguous is possible."""
    text = raw.strip()
    if text == "":
        return None

    # Code fences: ```json {…} ``` or ``` {…} ``` — wrapping is unambiguous.
    fence = re.fullmatch(r"^```(?:json)?\s*([\s\S]*?)\s*```$", text, re.I)
    if fence and fence.group(1):
        inner = fence.group(1).strip()
        if _try_parse(inner):
            return inner

    # A single complete JSON object with surrounding prose/whitespace.
    balanced = _extract_balanced_object(text)
    if balanced is not None and _try_parse(balanced):
        return balanced

    return None


def parse_tool_call_arguments(raw: str) -> dict:
    """Parse + validate tool-call arguments. Throws ToolCallParseError when the
    raw string cannot be safely turned into an argument object.
    Returns {"args": {...}, "repaired": bool}."""
    if raw.strip() == "":
        return {"args": {}, "repaired": False}

    direct = _try_parse(raw)
    if direct is not None:
        return {"args": direct, "repaired": False}

    fixed = _repair(raw)
    if fixed is not None:
        parsed = _try_parse(fixed)
        if parsed is not None:
            return {"args": parsed, "repaired": True}

    raise ToolCallParseError("Tool call arguments are not valid JSON.", sanitize_raw_for_log(raw))


def sanitize_arguments_for_wire(raw: str) -> str:
    """Ensure assistant messages never carry malformed tool-call arguments to
    the provider. Returns the original string when it is valid JSON, otherwise
    a safe `{}` placeholder."""
    try:
        json.loads(raw)
        return raw
    except Exception:
        return "{}"
