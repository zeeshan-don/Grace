"""list_directory tool (port of src/tools/listDirectory.ts)."""

import os

from grace.project.gitignore import is_ignored, load_gitignore_rules
from grace.project.walker import rel_from
from grace.safety import resolve_in_project
from grace.tools.tool import Tool
from grace.util_text import format_bytes


def create_list_directory_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        raw_path = args.get("path") if isinstance(args.get("path"), str) else ""
        depth = 1
        if isinstance(args.get("depth"), (int, float)) and depth is not None:
            depth = int(args.get("depth"))
        if args.get("recursive") is True and depth <= 1:
            depth = 3
        depth = max(1, min(depth, 5))

        if raw_path:
            resolved = resolve_in_project(ctx.projectRoot, raw_path)
            if not resolved["ok"]:
                return f"Error: {resolved['reason']}"
        else:
            resolved = {"abs": ctx.projectRoot, "real": ctx.projectRoot, "ok": True}

        try:
            if not os.path.isdir(resolved["abs"]):
                return f'Error: "{raw_path or "."}" is not a directory inside the project.'
        except OSError:
            return f'Error: "{raw_path or "."}" is not a directory inside the project.'

        lines: list[str] = []
        root_rules = load_gitignore_rules(ctx.projectRoot, "")

        def walk(dir_path: str, level: int, rules: list) -> None:
            if level > depth:
                return
            try:
                entries = sorted(os.listdir(dir_path))
            except OSError:
                return
            rel_dir = "" if dir_path == ctx.projectRoot else rel_from(ctx.projectRoot, dir_path)
            nested = rules if dir_path == ctx.projectRoot else load_gitignore_rules(dir_path, rel_dir)
            frame_rules = rules + nested

            for name in entries:
                abs_path = os.path.join(dir_path, name)
                rel = f"{rel_dir}/{name}" if rel_dir else name
                try:
                    st = os.stat(abs_path)
                except OSError:
                    continue
                is_dir = os.path.isdir(abs_path)
                # Respect .gitignore (skips .git, node_modules, .zeesh, .myagent, etc.)
                if is_ignored(rel, is_dir, frame_rules):
                    continue

                indent = "  " * level
                if is_dir:
                    lines.append(f"{indent}{name}/")
                    walk(abs_path, level + 1, frame_rules)
                else:
                    lines.append(f"{indent}{name}  {format_bytes(st.st_size)}")
                if len(lines) > 500:
                    lines.append("… [too many entries, listing truncated]")
                    return

        walk(resolved["abs"], 0, root_rules)

        if not lines:
            return "(empty directory)"
        label = rel_from(ctx.projectRoot, resolved["abs"]) if raw_path else "(project root)"
        return f"Listing {label}:\n" + "\n".join(lines)

    return Tool(
        name="list_directory",
        description="List files/dirs in a project directory.",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Dir relative to root (default root)."},
                "depth": {"type": "number", "description": "Recursion depth (1-5, default 1)."},
                "recursive": {"type": "boolean", "description": "Shorthand for depth 3."},
            },
        },
        execute=execute,
    )
