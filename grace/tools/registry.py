"""Tool registry (port of src/tools/registry.ts)."""

from grace.tools.edit_file import create_edit_file_tool
from grace.tools.git_diff import create_git_diff_tool
from grace.tools.list_directory import create_list_directory_tool
from grace.tools.read_file import create_read_file_tool
from grace.tools.run_command import create_run_command_tool
from grace.tools.search_files import create_search_files_tool
from grace.tools.web_fetch import create_web_fetch_tool
from grace.tools.tool import Tool, ToolContext
from grace.tools.write_file import create_write_file_tool


def create_tools(ctx: ToolContext) -> list[Tool]:
    """Build the full tool set available to the agent."""
    tools = [
        create_read_file_tool(ctx),
        create_write_file_tool(ctx),
        create_edit_file_tool(ctx),
        create_search_files_tool(ctx),
        create_list_directory_tool(ctx),
        create_run_command_tool(ctx),
        # Coordinator-only tools: not part of the default editor toolset, so the
        # default loop behavior is unchanged. The coordinator grants them by role.
        create_git_diff_tool(ctx),
        create_web_fetch_tool(ctx),
    ]
    return tools
