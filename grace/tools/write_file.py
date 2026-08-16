"""write_file tool (port of src/tools/writeFile.ts)."""

import os

from grace.project.walker import rel_from
from grace.safety import is_protected_path, resolve_in_project
from grace.tools.tool import Tool


def create_write_file_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        path = args.get("path") if isinstance(args.get("path"), str) else ""
        content = args.get("content") if isinstance(args.get("content"), str) else ""
        overwrite = args.get("overwrite") is not False
        if not path:
            return 'Error: "path" is required.'
        if content == "":
            return "Error: refusing to write an empty file; use edit_file to delete content instead."

        root = ctx.projectRoot
        resolved = resolve_in_project(root, path)
        if not resolved["ok"]:
            return f"Error: {resolved['reason']}"
        if is_protected_path(resolved["real"]) or is_protected_path(resolved["abs"]):
            return "Error: refusing to write to a protected file (.env, keys, credentials, SSH material)."

        if os.path.exists(resolved["abs"]) and not overwrite:
            return f'Error: "{path}" already exists and overwrite was set to false.'

        previous = None
        if os.path.exists(resolved["abs"]):
            try:
                with open(resolved["abs"], encoding="utf-8") as f:
                    previous = f.read()
            except Exception:
                previous = None

        try:
            os.makedirs(os.path.dirname(resolved["abs"]) or ".", exist_ok=True)
            with open(resolved["abs"], "w", encoding="utf-8") as f:
                f.write(content)
        except Exception as err:
            return f'Error: could not write "{path}": {err}'

        undo = getattr(ctx, "undo", None)
        if undo:
            undo.record(resolved["abs"], previous)
        rel = rel_from(root, resolved["abs"])
        return f"Wrote {len(content)} bytes to {rel}{' (new file)' if previous is None else ' (overwrote existing file)'}."

    return Tool(
        name="write_file",
        description="Create or overwrite a file with given content (dirs auto-created).",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root."},
                "content": {"type": "string", "description": "Complete new file content."},
                "overwrite": {"type": "boolean", "description": "Default true. false = refuse to overwrite."},
            },
            "required": ["path", "content"],
        },
        execute=execute,
    )
