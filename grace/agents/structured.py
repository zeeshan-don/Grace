"""Structured result parsing (port of src/agents/structured.ts).

Most agents end their final message with a JSON object
`{ summary, files, findings, recommendations }`. Parsing is best-effort:
malformed/absent JSON degrades to the raw final text as the summary, so the
coordinator never crashes on a sloppy model.
"""

import json


def extract_last_json_object(text: str) -> str | None:
    """Extract the last balanced JSON object from a string (brace counting)."""
    depth = 0
    start = -1
    for i in range(len(text) - 1, -1, -1):
        ch = text[i]
        if ch == "}":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "{":
            depth -= 1
            if depth == 0 and start != -1:
                return text[i:start + 1]
    return None


def parse_structured_result(text: str) -> dict | None:
    candidate = extract_last_json_object(text)
    if not candidate:
        return None
    try:
        parsed = json.loads(candidate)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    # Require at least one recognized field so random JSON in prose isn't
    # mistaken for a result block.
    if not any(k in parsed for k in ("summary", "files", "findings", "recommendations")):
        return None

    def str_array(v):
        if isinstance(v, list):
            return [x for x in v if isinstance(x, str)][:20]
        return None

    out: dict = {}
    if isinstance(parsed.get("summary"), str):
        out["summary"] = parsed["summary"][:2_000]
    files = str_array(parsed.get("files"))
    if files is not None:
        out["files"] = files
    findings = str_array(parsed.get("findings"))
    if findings is not None:
        out["findings"] = [s[:400] for s in findings]
    recs = str_array(parsed.get("recommendations"))
    if recs is not None:
        out["recommendations"] = [s[:400] for s in recs]
    return out
