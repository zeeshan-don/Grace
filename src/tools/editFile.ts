import { readFileSync, writeFileSync } from 'node:fs';
import { relFrom } from '../project/walker.ts';
import { isProtectedPath, resolveInProject } from '../safety/policy.ts';
import type { UndoStore } from '../session/undo.ts';
import type { Tool, ToolContext } from './registry.ts';

export interface EditOp {
  oldString: string;
  newString: string;
  allowMultiple?: boolean;
}

export function createEditFileTool(ctx: ToolContext & { undo?: UndoStore }): Tool {
  return {
    name: 'edit_file',
    description: 'Apply exact string replacements in a file (all-or-nothing).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to project root.' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string', description: 'Exact text to find.' },
              newString: { type: 'string', description: 'Replacement text.' },
              allowMultiple: { type: 'boolean', description: 'Replace all occurrences.' },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    async execute(args) {
      const path = typeof args.path === 'string' ? args.path : '';
      const edits = Array.isArray(args.edits) ? (args.edits as EditOp[]) : [];
      if (!path) return 'Error: "path" is required.';
      if (edits.length === 0) return 'Error: "edits" must contain at least one edit.';

      const resolved = resolveInProject(ctx.projectRoot, path);
      if (!resolved.ok) return `Error: ${resolved.reason}`;
      if (isProtectedPath(resolved.real) || isProtectedPath(resolved.abs)) {
        return 'Error: refusing to edit a protected file (.env, keys, credentials, SSH material).';
      }

      let original: string;
      try {
        original = readFileSync(resolved.abs, 'utf8');
      } catch {
        return `Error: could not read "${path}" for editing. Does it exist? Use write_file to create it.`;
      }

      // Validate every edit against the original content first.
      const problems: string[] = [];
      for (const edit of edits) {
        if (typeof edit.oldString !== 'string' || typeof edit.newString !== 'string') {
          problems.push('every edit needs string oldString and newString');
          continue;
        }
        const count = countOccurrences(original, edit.oldString);
        if (count === 0) {
          problems.push(`oldString not found in ${path}: ${JSON.stringify(edit.oldString.slice(0, 120))}`);
        } else if (count > 1 && !edit.allowMultiple) {
          problems.push(
            `oldString appears ${count} times in ${path}; set allowMultiple=true to replace all: ${JSON.stringify(edit.oldString.slice(0, 120))}`,
          );
        }
      }
      if (problems.length > 0) {
        return `Error: no changes were made.\n${problems.map((p) => ' - ' + p).join('\n')}`;
      }

      let next = original;
      for (const edit of edits) {
        next = edit.allowMultiple ? replaceAll(next, edit.oldString, edit.newString) : next.replace(edit.oldString, edit.newString);
      }
      if (next === original) return 'No changes needed — the file already matches the target.';

      ctx.undo?.record(resolved.abs, original);
      try {
        writeFileSync(resolved.abs, next, 'utf8');
      } catch (err) {
        return `Error: could not write "${path}": ${(err as Error).message}`;
      }

      const rel = relFrom(ctx.projectRoot, resolved.abs);
      return `Edited ${rel}: ${edits.length} edit(s) applied (${original.length} → ${next.length} chars).`;
    },
  };
}

export function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export function replaceAll(text: string, needle: string, replacement: string): string {
  return text.split(needle).join(replacement);
}
