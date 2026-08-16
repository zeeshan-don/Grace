"""web_fetch tool (port of src/tools/webFetch.ts)."""

import re

import requests

from grace.tools.tool import Tool
from grace.util_text import truncate_middle

DEFAULT_TIMEOUT_MS = 15_000
MAX_CHARS = 20_000


def _strip_html(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<!--[\s\S]*?-->", " ", text)
    text = re.sub(r"<(?!/?(p|br|li|h[1-6]|pre|code|tr|div)\b)[^>]*>", "", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6]|tr|pre|code)\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def create_web_fetch_tool(_ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        url = args.get("url") if isinstance(args.get("url"), str) else ""
        url = url.strip()
        if not re.match(r"^https?://", url, re.I):
            return 'Error: "url" must be a full http(s) URL.'
        max_chars = MAX_CHARS
        if isinstance(args.get("maxChars"), (int, float)) and args.get("maxChars") > 0:
            max_chars = min(int(args.get("maxChars")), MAX_CHARS)

        try:
            res = requests.get(url, headers={"User-Agent": "zeesh-researcher/0.1"}, timeout=DEFAULT_TIMEOUT_MS / 1000, allow_redirects=True)
        except requests.exceptions.Timeout:
            return f"Error: could not fetch {url} (timed out)."
        except requests.exceptions.RequestException as err:
            return f"Error: could not fetch {url} ({err})."
        if not res.ok:
            return f"Error: {url} returned HTTP {res.status_code}."
        if res.status_code == 204:
            return "(empty response)"
        content_length = len(res.content)
        if content_length > 10 * 1024 * 1024:
            return f"Error: {url} is too large ({round(content_length / 1024 / 1024)} MB)."

        text = res.text or ""
        readable = _strip_html(text).strip()
        if not readable:
            return "(page contains no readable text)"
        return truncate_middle(readable, max_chars)

    return Tool(
        name="web_fetch",
        description="Fetch a public HTTP(S) URL and return its readable text. Read-only; best for docs and reference pages.",
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full http(s) URL to fetch."},
                "maxChars": {"type": "number", "description": "Response cap in chars (default 20000)."},
            },
            "required": ["url"],
        },
        execute=execute,
    )
