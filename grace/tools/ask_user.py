"""Ask user tool (port of packages/agent-runtime/src/tools/handlers/ask-user).

During a task, the agent may need to ask the user a question — which approach
to take, which option to prefer, whether to proceed with a risky change. The
ask_user tool pauses execution and presents a multiple-choice question (or
free-text input) to the user.

This is different from the permission dialog: permissions are about letting
the agent DO something (run a command, write a file), while ask_user is about
GATHERING INFORMATION from the user.

The tool blocks until the user answers, then returns their response to the
agent so it can continue.
"""

from __future__ import annotations

from grace.tools.tool import Tool, ToolContext


def create_ask_user_tool(ctx: ToolContext) -> Tool:
    return Tool(
        name="ask_user",
        description=(
            "Ask the user a question and pause execution until they respond. "
            "Use this when you need to make an important decision and want the user's input — "
            "for example, choosing between implementation approaches, confirming requirements, "
            "or clarifying ambiguous requirements. "
            "Supports single-select (radio) and multi-select (checkbox) modes."
        ),
        parameters={
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to ask the user.",
                },
                "options": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Option label."},
                            "description": {"type": "string", "description": "Optional description."},
                        },
                        "required": ["label"],
                    },
                    "description": "List of answer options (at least 2).",
                },
                "multiSelect": {
                    "type": "boolean",
                    "description": "If true, the user can select multiple options. Default false.",
                },
            },
            "required": ["question", "options"],
        },
        execute=lambda args, tool_ctx: _execute_ask_user(args, tool_ctx),
    )


def _execute_ask_user(args: dict, tool_ctx: ToolContext) -> str:
    question = args.get("question", "").strip()
    options = args.get("options", [])
    multi_select = args.get("multiSelect", False)

    if not question:
        return "Error: 'question' is required."
    if not options or len(options) < 2:
        return "Error: at least 2 options are required."

    # Format the question for the user
    lines = [f"\n  {question}", ""]
    for i, opt in enumerate(options):
        label = opt.get("label", "")
        desc = opt.get("description", "")
        marker = "○" if not multi_select else "☐"
        lines.append(f"  {marker} [{i + 1}] {label}")
        if desc:
            lines.append(f"      {desc}")
    lines.append("")
    if multi_select:
        lines.append("  Select one or more (comma-separated numbers), or type a custom answer:")
    else:
        lines.append("  Select an option (number) or type a custom answer:")

    prompt_text = "\n".join(lines)

    # Use the on_ask_user callback if available, otherwise fall back to stdin
    on_ask = tool_ctx._ask_user if hasattr(tool_ctx, "_ask_user") else None
    if on_ask:
        response = on_ask(question, options, multi_select)
        if response is None:
            return "User skipped the question."
        return f"User response: {response}"

    # Fallback: synchronous stdin prompt
    try:
        print(prompt_text)
        answer = input("  > ").strip()
        if not answer:
            return "User skipped the question."

        # Try to parse as option numbers
        try:
            nums = [int(x.strip()) for x in answer.split(",")]
            selected = []
            for n in nums:
                if 1 <= n <= len(options):
                    selected.append(options[n - 1].get("label", str(n)))
            if selected:
                if multi_select:
                    return f"User selected: {', '.join(selected)}"
                return f"User selected: {selected[0]}"
        except (ValueError, IndexError):
            pass

        # Free-text response
        return f"User response: {answer}"
    except (EOFError, KeyboardInterrupt):
        return "User skipped the question."
