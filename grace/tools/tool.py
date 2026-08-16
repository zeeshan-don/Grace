"""Core tool types (Tool + ToolContext), isolated so tool modules and the
registry can import them without circular dependencies."""

from dataclasses import dataclass, field
from typing import Callable


class ToolContext:
    """Simple mutable context object passed to every tool execute().

    Mirrors the TS ToolContext (projectRoot, askPermission, onTool,
    commandPolicy) plus the optional undo store for write/edit tools.
    """

    def __init__(self, projectRoot: str, askPermission, onTool=None, commandPolicy=None, undo=None) -> None:
        self.projectRoot = projectRoot
        self.askPermission = askPermission
        self.onTool = onTool
        self.commandPolicy = commandPolicy
        self.undo = undo

    def with_undo(self, undo):
        self.undo = undo
        return self


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    execute: Callable[[dict, ToolContext], str] = field(default=lambda args, ctx: "")
