import { createReadFileTool } from './readFile.ts';
import { createWriteFileTool } from './writeFile.ts';
import { createEditFileTool } from './editFile.ts';
import { createSearchFilesTool } from './searchFiles.ts';
import { createListDirectoryTool } from './listDirectory.ts';
import { createRunCommandTool } from './runCommand.ts';
import type { UndoStore } from '../session/undo.ts';

export interface ToolContext {
  projectRoot: string;
  /** Ask the user to approve a flagged command. Returns true when allowed. */
  askPermission: (command: string, reasons: string[]) => Promise<boolean>;
  /** Called when a tool starts executing (used for status lines). */
  onTool?: (name: string, args: Record<string, unknown>) => void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Build the full tool set available to the agent. */
export function createTools(ctx: ToolContext & { undo?: UndoStore }): Tool[] {
  const base = { undo: ctx.undo };
  return [
    createReadFileTool(ctx),
    createWriteFileTool({ ...ctx, ...base }),
    createEditFileTool({ ...ctx, ...base }),
    createSearchFilesTool(ctx),
    createListDirectoryTool(ctx),
    createRunCommandTool(ctx),
  ];
}
