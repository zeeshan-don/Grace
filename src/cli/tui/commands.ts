/**
 * Slash command definitions (TUI command palette + home-screen shortcuts).
 *
 * Every entry maps to a REAL, working command — the palette and the home
 * shortcuts are shortcuts for typing the same slash command into the input.
 * No dummy suggestions.
 */
import type { SlashCommandDef } from './types.ts';

/**
 * The small set of REAL commands surfaced on the startup screen. Each one
 * executes the actual command when activated (Tab to focus, ←/→ to select,
 * Enter to run). /settings does not exist in GRACE, so the preferences spot
 * is filled by /provider — a real, working command.
 */
export interface HomeShortcut {
  name: string;
  description: string;
}

export const HOME_SHORTCUTS: HomeShortcut[] = [
  { name: '/help', description: 'Show commands' },
  { name: '/status', description: 'Workspace & session' },
  { name: '/model', description: 'Switch model' },
  { name: '/provider', description: 'Switch provider' },
];

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: '/help', usage: '/help', description: 'Show commands' },
  { name: '/status', usage: '/status', description: 'Workspace, provider and session status' },
  { name: '/model', usage: '/model [id]', description: 'Show model or open the picker' },
  { name: '/provider', usage: '/provider [name]', description: 'Show provider or open the picker' },
  { name: '/cd', usage: '/cd <path>', description: 'Change the workspace' },
  { name: '/diff', usage: '/diff', description: 'Show git changes (or agent-modified files)' },
  { name: '/clear', usage: '/clear', description: 'Clear the output' },
  { name: '/reset', usage: '/reset', description: 'Reset the conversation/task context' },
  { name: '/undo', usage: '/undo', description: 'Revert the last file change by the agent' },
  { name: '/debug', usage: '/debug [on|off]', description: 'Toggle debug diagnostics' },
  { name: '/login', usage: '/login [email]', description: 'Log in to the GRACE backend' },
  { name: '/register', usage: '/register [email]', description: 'Create a GRACE account' },
  { name: '/logout', usage: '/logout', description: 'Log out and remove the local session' },
  { name: '/whoami', usage: '/whoami', description: 'Show the authenticated identity' },
  { name: '/exit', usage: '/exit', description: 'Exit Grace' },
];
