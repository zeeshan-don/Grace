"""Suggest followups tool (port of packages/agent-runtime/src/tools/handlers/suggest-followups).

At the end of a task, the agent can suggest ~3 next steps the user might want
to take. These appear as clickable cards in the TUI. The suggestions should be:

- Short and goal-oriented (name the outcome, not the steps)
- Relevant to what was just done
- Not obvious/redundant (don't suggest "run tests" if tests already passed)
"""

from __future__ import annotations

from grace.tools.tool import Tool, ToolContext


def create_suggest_followups_tool(ctx: ToolContext) -> Tool:
    return Tool(
        name="suggest_followups",
        description=(
            "Suggest clickable followup prompts to the user. When the user clicks a suggestion, "
            "it sends that prompt as a new user message. "
            "Use this after completing a task to suggest what the user might want to do next. "
            "Good suggestions include:\n"
            "- Alternatives to the latest implementation\n"
            "- Related features\n"
            "- Cleanup opportunities\n"
            "- Testing suggestions\n"
            "- Verification steps\n\n"
            "Aim for around 3 suggestions. Keep each one short and goal-oriented."
        ),
        parameters={
            "type": "object",
            "properties": {
                "followups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {
                                "type": "string",
                                "description": "The prompt text to send as a user message when clicked.",
                            },
                            "label": {
                                "type": "string",
                                "description": "Short display label for the suggestion card.",
                            },
                        },
                        "required": ["prompt"],
                    },
                    "description": "List of 2-4 followup suggestions.",
                },
            },
            "required": ["followups"],
        },
        execute=lambda args, tool_ctx: _execute_suggest_followups(args, tool_ctx),
    )


def _execute_suggest_followups(args: dict, tool_ctx: ToolContext) -> str:
    followups = args.get("followups", [])
    if not followups:
        return "No followups provided."

    if not isinstance(followups, list):
        return "Error: 'followups' must be a list of objects."

    # Validate and format
    valid = []
    for i, f in enumerate(followups):
        if not isinstance(f, dict):
            continue
        prompt = f.get("prompt", "").strip()
        label = f.get("label", "").strip() or prompt[:40]
        if prompt:
            valid.append({"prompt": prompt, "label": label, "index": i})

    if not valid:
        return "No valid followups found."

    # Format for the TUI to render as clickable cards
    lines = []
    for s in valid:
        lines.append(f"  [{s['index'] + 1}] {s['label']}")
        lines.append(f"      {s['prompt']}")

    result = f"Suggested followups ({len(valid)}):\n" + "\n".join(lines)
    result += "\n\nClick a suggestion or type its number to run it."
    return result
