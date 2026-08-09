import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInProject } from '../safety/policy.ts';
import { relFrom } from '../project/walker.ts';
import { isIgnored, type IgnoreRule, loadGitignoreRules } from '../project/gitignore.ts';
import { formatBytes } from '../util/text.ts';
import type { Tool, ToolContext } from './registry.ts';

export function createListDirectoryTool(ctx: ToolContext): Tool {
  return {
    name: 'list_directory',
    description: 'List files/dirs in a project directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dir relative to root (default root).' },
        depth: { type: 'number', description: 'Recursion depth (1-5, default 1).' },
        recursive: { type: 'boolean', description: 'Shorthand for depth 3.' },
      },
    },
    async execute(args) {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      let depth = typeof args.depth === 'number' && Number.isFinite(args.depth) ? Math.floor(args.depth) : 1;
      if (args.recursive === true && depth <= 1) depth = 3;
      depth = Math.max(1, Math.min(depth, 5));

      const resolved = rawPath ? resolveInProject(ctx.projectRoot, rawPath) : { abs: ctx.projectRoot, real: ctx.projectRoot, ok: true as const };
      if (!resolved.ok) return `Error: ${resolved.reason}`;
      if (!statSyncSafe(resolved.abs)?.isDirectory()) {
        return `Error: "${rawPath || '.'}" is not a directory inside the project.`;
      }

      const lines: string[] = [];
      const rootRules = loadGitignoreRules(ctx.projectRoot, '');
      walk(resolved.abs, 0, rootRules);

      function walk(dir: string, level: number, rules: IgnoreRule[]): void {
        if (level > depth) return;
        let entries: string[];
        try {
          entries = readdirSync(dir).sort();
        } catch {
          return;
        }
        const relDir = dir === ctx.projectRoot ? '' : relFrom(ctx.projectRoot, dir);
        const nested = dir === ctx.projectRoot ? rules : loadGitignoreRules(dir, relDir);
        const frameRules = rules.concat(nested);

        for (const name of entries) {
          const abs = join(dir, name);
          const rel = relDir ? `${relDir}/${name}` : name;
          let st;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          const isDir = st.isDirectory();
          // Respect .gitignore (skips .git, node_modules, .myagent, etc.)
          if (isIgnored(rel, isDir, frameRules)) continue;

          const indent = '  '.repeat(level);
          if (isDir) {
            lines.push(`${indent}${name}/`);
            walk(abs, level + 1, frameRules);
          } else {
            lines.push(`${indent}${name}  ${formatBytes(st.size)}`);
          }
          if (lines.length > 500) {
            lines.push('… [too many entries, listing truncated]');
            return;
          }
        }
      }

      if (lines.length === 0) return '(empty directory)';
      const label = rawPath ? relFrom(ctx.projectRoot, resolved.abs) : '(project root)';
      return `Listing ${label}:\n${lines.join('\n')}`;
    },
  };
}

function statSyncSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
