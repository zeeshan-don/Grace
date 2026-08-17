"""read_file tool (port of src/tools/readFile.ts)."""

from grace.project.walker import read_file_safe
from grace.safety import is_protected_path, resolve_in_project
from grace.tools.tool import Tool
from grace.util_text import truncate_text

MAX_FILE_CHARS = 40_000


def create_read_file_tool(_ctx) -> Tool:
    def execute(args: dict, ctx) -> str:
        path = args.get("path") if isinstance(args.get("path"), str) else ""
        if not path:
            return 'Error: "path" is required.'

        resolved = resolve_in_project(ctx.projectRoot, path)
        if not resolved["ok"]:
            return f"Error: {resolved['reason']}"
        if is_protected_path(resolved["real"]) or is_protected_path(resolved["abs"]):
            return "Error: refusing to read a protected file (.env, keys, credentials, SSH material)."

        try:
            result = read_file_safe(resolved["abs"])
            note = "\n[file partially read — too large]" if result["truncated"] else ""
            return truncate_text(result["content"], MAX_FILE_CHARS) + note
        except Exception as err:
            return f'Error: could not read "{path}": {err}'

    return Tool(name="read_file", description="Read a file from the project (truncated if huge).", parameters={
        "type": "object",
        "properties": {"path": {"type": "string", "description": "Path relative to project root."}},
        "required": ["path"],
    }, execute=execute)
