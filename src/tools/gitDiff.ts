import { diffStat, diffUnified, gitSummary, recentLog, statusShort } from '../git/git.ts';
import { truncateMiddle } from '../util/text.ts';
import type { Tool } from './registry.ts';

/**
 * Read-only git inspection tool (subagent coordinator).
 *
 * Grants the code reviewer and git curator safe access to the working tree
 * status and diff without ever mutating the repository. All operations are
 * pure reads (status/stat/diff/log) — no `add`/`commit`/`push` here; those go
 * through the git curator's gated `run_command`.
 */
export function createGitDiffTool(ctx: { projectRoot: string }): Tool {
  return {
    name: 'git_diff',
    description:
      'Read-only git inspection: working tree status, diff stat, unified diff, recent log. Never modifies anything.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['status', 'stat', 'diff', 'log', 'summary'],
          description: 'What to show (default summary).',
        },
        maxLines: { type: 'number', description: 'Diff line cap (default 300).' },
      },
    },
    async execute(args) {
      const root = ctx.projectRoot;
      const scope = typeof args.scope === 'string' ? args.scope : 'summary';
      const maxLines = typeof args.maxLines === 'number' && args.maxLines > 0 ? args.maxLines : 300;

      const g = gitSummary(root);
      if (!g.isRepo) return 'Not a git repository — nothing to inspect.';

      switch (scope) {
        case 'status': {
          const s = statusShort(root);
          return s.trim() ? s : 'Working tree clean.';
        }
        case 'stat': {
          const s = diffStat(root);
          return s.trim() ? s : 'No uncommitted changes.';
        }
        case 'diff': {
          const d = diffUnified(root, maxLines);
          return d.trim() ? truncateMiddle(d, 60_000) : 'No uncommitted changes.';
        }
        case 'log': {
          const l = recentLog(root, maxLines > 20 ? 20 : maxLines);
          return l.trim() ? l : 'No commits yet.';
        }
        default: {
          const status = statusShort(root).trim();
          const recent = recentLog(root, 3);
          return [
            `branch: ${g.branch ?? 'detached'}`,
            `working tree: ${g.hasChanges ? `${g.statusLines} change(s)` : 'clean'}`,
            status ? `status:\n${status.split('\n').slice(0, 20).join('\n')}` : '',
            recent.trim() ? `recent commits:\n${recent}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      }
    },
  };
}
