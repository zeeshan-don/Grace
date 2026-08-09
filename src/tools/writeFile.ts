import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { relFrom } from '../project/walker.ts';
import { isProtectedPath, resolveInProject } from '../safety/policy.ts';
import type { UndoStore } from '../session/undo.ts';
import type { Tool, ToolContext } from './registry.ts';

export function createWriteFileTool(ctx: ToolContext & { undo?: UndoStore }): Tool {
  return {
    name: 'write_file',
    description: 'Create or overwrite a file with given content (dirs auto-created).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to project root.' },
        content: { type: 'string', description: 'Complete new file content.' },
        overwrite: { type: 'boolean', description: 'Default true. false = refuse to overwrite.' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const path = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const overwrite = args.overwrite !== false;
      if (!path) return 'Error: "path" is required.';
      if (content === '') return 'Error: refusing to write an empty file; use edit_file to delete content instead.';

      const resolved = resolveInProject(ctx.projectRoot, path);
      if (!resolved.ok) return `Error: ${resolved.reason}`;
      if (isProtectedPath(resolved.real) || isProtectedPath(resolved.abs)) {
        return 'Error: refusing to write to a protected file (.env, keys, credentials, SSH material).';
      }

      if (existsSync(resolved.abs) && !overwrite) {
        return `Error: "${path}" already exists and overwrite was set to false.`;
      }

      let previous: string | null = null;
      if (existsSync(resolved.abs)) {
        try {
          previous = readFileSync(resolved.abs, 'utf8');
        } catch {
          previous = null;
        }
      }

      try {
        mkdirSync(dirname(resolved.abs), { recursive: true });
        writeFileSync(resolved.abs, content, 'utf8');
      } catch (err) {
        return `Error: could not write "${path}": ${(err as Error).message}`;
      }

      ctx.undo?.record(resolved.abs, previous);
      const rel = relFrom(ctx.projectRoot, resolved.abs);
      return `Wrote ${content.length} bytes to ${rel}${previous === null ? ' (new file)' : ' (overwrote existing file)'}.`;
    },
  };
}
