"""git_diff tool (port of src/tools/gitDiff.ts) — read-only git inspection."""

from grace.git import diff_stat, diff_unified, git_summary, recent_log, status_short
from grace.tools.tool import Tool
from grace.util_text import truncate_middle


def create_git_diff_tool(ctx) -> Tool:
    def execute(args: dict, tool_ctx) -> str:
        root = ctx.projectRoot
        scope = args.get("scope") if isinstance(args.get("scope"), str) else "summary"
        max_lines = args.get("maxLines") if isinstance(args.get("maxLines"), (int, float)) and args.get("maxLines") > 0 else 300
        max_lines = int(max_lines)

        g = git_summary(root)
        if not g["isRepo"]:
            return "Not a git repository — nothing to inspect."

        if scope == "status":
            s = status_short(root)
            return s.strip() if s.strip() else "Working tree clean."
        if scope == "stat":
            s = diff_stat(root)
            return s.strip() if s.strip() else "No uncommitted changes."
        if scope == "diff":
            d = diff_unified(root, max_lines)
            return truncate_middle(d, 60_000) if d.strip() else "No uncommitted changes."
        if scope == "log":
            l = recent_log(root, min(max_lines, 20))
            return l.strip() if l.strip() else "No commits yet."

        status = status_short(root).strip()
        recent = recent_log(root, 3)
        parts = [
            f"branch: {g['branch'] or 'detached'}",
            f"working tree: {g['statusLines']} change(s)" if g["hasChanges"] else "working tree: clean",
            ("status:\n" + "\n".join(status.split("\n")[:20])) if status else "",
            f"recent commits:\n{recent}" if recent.strip() else "",
        ]
        return "\n".join(p for p in parts if p)

    return Tool(
        name="git_diff",
        description="Read-only git inspection: working tree status, diff stat, unified diff, recent log. Never modifies anything.",
        parameters={
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["status", "stat", "diff", "log", "summary"],
                    "description": "What to show (default summary).",
                },
                "maxLines": {"type": "number", "description": "Diff line cap (default 300)."},
            },
        },
        execute=execute,
    )
