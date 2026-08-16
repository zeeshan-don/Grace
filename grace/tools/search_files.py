"""search_files tool (port of src/tools/searchFiles.ts)."""

import os
import re
import subprocess

from grace.project.walker import walk_files
from grace.safety import is_protected_path, redact_secrets
from grace.tools.tool import Tool
from grace.util_text import truncate_text

MAX_RESULTS = 100
MAX_OUTPUT = 30_000


def _escape_regexp(s: str) -> str:
    return re.escape(s)


def _build_regex(query: str, ci: bool, word: bool) -> re.Pattern:
    flags = re.I if ci else 0
    if word:
        return re.compile(rf"\b{_escape_regexp(query)}\b", flags)
    return re.compile(_escape_regexp(query), flags)


def _globs_match(globs: list[str], rel: str) -> bool:
    matched = False
    for g in globs:
        neg = g.startswith("!")
        pat = g[1:] if neg else g
        pattern = "^" + pat.replace("*", "[^/]*") + "$"
        if re.match(pattern, rel):
            matched = not neg
    return matched


def _search_filenames(query: str, ci: bool, max_results: int, globs: list[str], root: str) -> str:
    files = walk_files(root, max_files=5000)
    pattern = re.compile(_escape_regexp(query), re.I if ci else 0)
    matches = [
        f for f in files
        if (not globs or _globs_match(globs, f.rel)) and pattern.search(f.rel)
    ]
    if not matches:
        return f"No files whose path matches {json_dumps(query)}."
    shown = matches[:max_results]
    extra = f"\n… and {len(matches) - len(shown)} more" if len(matches) > len(shown) else ""
    return f"Files matching {json_dumps(query)}:\n" + "\n".join(f.rel for f in shown) + extra


def _search_fallback(root: str, query: str, ci: bool, word: bool, max_results: int) -> list[str]:
    files = walk_files(root, max_files=5000)
    pattern = _build_regex(query, ci, word)
    out: list[str] = []
    for file in files:
        if is_protected_path(file.abs):
            continue
        if file.size > 2_000_000:
            continue  # skip huge / binary-ish files
        try:
            with open(file.abs, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception:
            continue
        if "\u0000" in text:
            continue  # binary
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if len(out) >= max_results:
                break
            if pattern.search(line):
                out.append(f"{file.rel}:{i + 1}: {truncate_text(line.strip(), 200)}")
        if len(out) >= max_results:
            break
    return out


def _try_ripgrep(ctx, query: str, ci: bool, word: bool, globs: list[str], max_results: int) -> dict:
    args = ["--line-number", "--no-heading", "--color=never", "--max-columns", "200"]
    if ci:
        args.append("-i")
    if word:
        args.append("-w")
    if max_results:
        args += ["-m", str(max_results)]
    for g in globs:
        args += ["-g", g]
    args += ["--", query, "."]
    try:
        res = subprocess.run(
            ["rg", *args],
            cwd=ctx.projectRoot,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except Exception:
        return {"found": False, "output": ""}
    if res.returncode == 2:
        return {"found": False, "output": ""}
    if res.returncode == 1:
        return {"found": True, "output": "No matches."}
    return {"found": True, "output": res.stdout or "No matches."}


def json_dumps(s: str) -> str:
    import json
    return json.dumps(s)


def create_search_files_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        query = args.get("query") if isinstance(args.get("query"), str) else ""
        mode = "filename" if args.get("mode") == "filename" else "content"
        ci = args.get("caseInsensitive") is not False
        word = args.get("word") is True
        globs = [g for g in (args.get("globs") or []) if isinstance(g, str)]
        max_results = MAX_RESULTS
        if isinstance(args.get("maxResults"), (int, float)) and args.get("maxResults") > 0:
            max_results = min(int(args.get("maxResults")), MAX_RESULTS)

        if not query:
            return 'Error: "query" is required.'

        if mode == "filename":
            return _search_filenames(query, ci, max_results, globs, ctx.projectRoot)

        # Try ripgrep first (fast, respects .gitignore); fall back to the built-in walker.
        rg = _try_ripgrep(ctx, query, ci, word, globs, max_results)
        if rg["found"]:
            return truncate_text(redact_secrets(rg["output"]), MAX_OUTPUT)

        results = _search_fallback(ctx.projectRoot, query, ci, word, max_results)
        if not results:
            return f"No matches for {json_dumps(query)}."
        return truncate_text(redact_secrets("\n".join(results)), MAX_OUTPUT)

    return Tool(
        name="search_files",
        description="Search repo for text/symbols/filenames (honors .gitignore).",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for."},
                "mode": {"type": "string", "enum": ["content", "filename"], "description": "Default content."},
                "caseInsensitive": {"type": "boolean", "description": "Default true."},
                "word": {"type": "boolean", "description": "Whole word only."},
                "globs": {"type": "array", "items": {"type": "string"}, "description": "File glob filters."},
                "maxResults": {"type": "number", "description": "Cap on matches."},
            },
            "required": ["query"],
        },
        execute=execute,
    )
