"""edit_file tool (port of src/tools/editFile.ts)."""

import json
import os

from grace.project.walker import rel_from
from grace.safety import is_protected_path, resolve_in_project
from grace.tools.tool import Tool


def count_occurrences(text: str, needle: str) -> int:
    if needle == "":
        return 0
    return text.count(needle)


def replace_all(text: str, needle: str, replacement: str) -> str:
    return text.replace(needle, replacement)


def create_edit_file_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        path = args.get("path") if isinstance(args.get("path"), str) else ""
        edits = args.get("edits") if isinstance(args.get("edits"), list) else []
        if not path:
            return 'Error: "path" is required.'
        if len(edits) == 0:
            return 'Error: "edits" must contain at least one edit.'

        resolved = resolve_in_project(ctx.projectRoot, path)
        if not resolved["ok"]:
            return f"Error: {resolved['reason']}"
        if is_protected_path(resolved["real"]) or is_protected_path(resolved["abs"]):
            return "Error: refusing to edit a protected file (.env, keys, credentials, SSH material)."

        try:
            with open(resolved["abs"], encoding="utf-8") as f:
                original = f.read()
        except Exception:
            return f'Error: could not read "{path}" for editing. Does it exist? Use write_file to create it.'

        # Validate every edit against the original content first.
        problems: list[str] = []
        for edit in edits:
            if not isinstance(edit, dict):
                problems.append("every edit needs string oldString and newString")
                continue
            old_string = edit.get("oldString")
            new_string = edit.get("newString")
            if not isinstance(old_string, str) or not isinstance(new_string, str):
                problems.append("every edit needs string oldString and newString")
                continue
            count = count_occurrences(original, old_string)
            if count == 0:
                problems.append(f"oldString not found in {path}: {json.dumps(old_string[:120])}")
            elif count > 1 and not edit.get("allowMultiple"):
                problems.append(
                    f"oldString appears {count} times in {path}; set allowMultiple=true to replace all: {json.dumps(old_string[:120])}"
                )
        if problems:
            return "Error: no changes were made.\n" + "\n".join(" - " + p for p in problems)

        next_text = original
        for edit in edits:
            old_string = edit["oldString"]
            new_string = edit["newString"]
            if edit.get("allowMultiple"):
                next_text = replace_all(next_text, old_string, new_string)
            else:
                next_text = next_text.replace(old_string, new_string, 1)
        if next_text == original:
            return "No changes needed — the file already matches the target."

        undo = getattr(ctx, "undo", None)
        if undo:
            undo.record(resolved["abs"], original)
        try:
            with open(resolved["abs"], "w", encoding="utf-8") as f:
                f.write(next_text)
        except Exception as err:
            return f'Error: could not write "{path}": {err}'

        rel = rel_from(ctx.projectRoot, resolved["abs"])
        return f"Edited {rel}: {len(edits)} edit(s) applied ({len(original)} → {len(next_text)} chars)."

    return Tool(
        name="edit_file",
        description="Apply exact string replacements in a file (all-or-nothing).",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root."},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldString": {"type": "string", "description": "Exact text to find."},
                            "newString": {"type": "string", "description": "Replacement text."},
                            "allowMultiple": {"type": "boolean", "description": "Replace all occurrences."},
                        },
                        "required": ["oldString", "newString"],
                    },
                },
            },
            "required": ["path", "edits"],
        },
        execute=execute,
    )
