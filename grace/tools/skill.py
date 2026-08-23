"""Skill system (port of packages/agent-runtime/src/tools/handlers/skill).

Skills are reusable, self-contained instruction files that teach the agent
how to accomplish a specific task. They live in ``.agents/skills/`` within
the project root and follow a simple naming convention:

    .agents/skills/<name>.md

Each file is a markdown document whose first heading is the skill name and
whose body contains the instructions. The skill tool lets the agent:

1. **load** — Read a skill by name and inject its instructions into the
   current context.
2. **list** — Discover available skills by scanning the skills directory.

Skills can also be installed from community repos via ``npx skills find/add``
(TODO: wire up install flow).
"""

from __future__ import annotations

from pathlib import Path

from grace.tools.tool import Tool, ToolContext


def _skills_dir(project_root: str) -> Path:
    return Path(project_root) / ".agents" / "skills"


def _discover_skills(project_root: str) -> list[dict]:
    """Scan .agents/skills/ for available skill files."""
    d = _skills_dir(project_root)
    if not d.is_dir():
        return []
    skills: list[dict] = []
    for f in sorted(d.iterdir()):
        if f.suffix == ".md" and f.is_file():
            name = f.stem
            # Extract the first heading as the display name.
            try:
                text = f.read_text(encoding="utf-8")
            except Exception:
                continue
            first_line = text.split("\n", 1)[0].strip().lstrip("#").strip()
            display = first_line if first_line else name
            skills.append({"name": name, "displayName": display, "path": str(f)})
    return skills


def _load_skill(project_root: str, name: str) -> str | None:
    """Load a skill file by name. Returns the content or None."""
    d = _skills_dir(project_root)
    # Normalize: accept "my-skill" or "my_skill" or even "mySkill"
    candidates = [name, name.replace("-", "_"), name.replace("_", "-")]
    for candidate in candidates:
        path = d / f"{candidate}.md"
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8")
            except Exception:
                return None
    return None


def create_skill_tool(ctx: ToolContext) -> Tool:
    return Tool(
        name="skill",
        description=(
            "Load a skill by name to get its full instructions. Skills provide reusable behaviors "
            "and domain-specific knowledge that you can use to complete tasks. "
            "Use `list` action to discover available skills, then `load` to read one."
        ),
        parameters={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["load", "list"],
                    "description": "Which operation to perform: 'list' to discover skills, 'load' to read one.",
                },
                "name": {
                    "type": "string",
                    "description": "The name of the skill to load (required when action is 'load').",
                },
            },
            "required": ["action"],
        },
        execute=lambda args, tool_ctx: _execute_skill(args, tool_ctx, ctx.projectRoot),
    )


def _execute_skill(args: dict, tool_ctx: ToolContext, project_root: str) -> str:
    action = args.get("action", "list")

    if action == "list":
        skills = _discover_skills(project_root)
        if not skills:
            return (
                "No skills found. Skills live in .agents/skills/<name>.md within the project.\n"
                "To install community skills, run: npx skills find <query>"
            )
        lines = ["Available skills:"]
        for s in skills:
            lines.append(f"  - {s['name']}: {s['displayName']}")
        lines.append("")
        lines.append("Use action='load' with name='<skill-name>' to read a skill's instructions.")
        return "\n".join(lines)

    if action == "load":
        name = args.get("name", "").strip()
        if not name:
            return "Error: 'name' parameter is required when action is 'load'."
        content = _load_skill(project_root, name)
        if content is None:
            # Also check if there's a globally installed skill
            skills = _discover_skills(project_root)
            available = [s["name"] for s in skills]
            return (
                f"Skill '{name}' not found in .agents/skills/.\n"
                f"Available skills: {', '.join(available) if available else '(none)'}\n"
                "To install community skills, run: npx skills find <query>"
            )
        return f"## Skill: {name}\n\n{content}"

    return f"Error: unknown action '{action}'. Use 'list' or 'load'."
