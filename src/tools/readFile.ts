import { readFileSync } from 'node:fs';
import { relFrom, readFileSafe } from '../project/walker.ts';
import { isProtectedPath, resolveInProject } from '../safety/policy.ts';
import { truncateText } from '../util/text.ts';
import type { Tool, ToolContext } from './registry.ts';

const MAX_FILE_CHARS = 40_000;

export function createReadFileTool(_ctx: ToolContext): Tool {
  return {
    name: 'read_file',
    description: 'Read a file from the project (truncated if huge).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to project root.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return 'Error: "path" is required.';

      const resolved = resolveInProject(_ctx.projectRoot, path);
      if (!resolved.ok) return `Error: ${resolved.reason}`;
      if (isProtectedPath(resolved.real) || isProtectedPath(resolved.abs)) {
        return 'Error: refusing to read a protected file (.env, keys, credentials, SSH material).';
      }

      try {
        const { content, truncated } = readFileSafe(resolved.abs);
        const note = truncated ? '\n[file partially read — too large]' : '';
        return truncateText(content, MAX_FILE_CHARS) + note;
      } catch (err) {
        return `Error: could not read "${path}": ${(err as Error).message}`;
      }
    },
  };
}
