/**
 * `grace --new-window` — open Grace in a separate terminal window.
 *
 * The current working directory is preserved as the workspace: the new window
 * runs the exact same `grace` REPL against the directory the command was
 * executed in. The launcher never changes directory itself, so Grace never
 * accidentally starts from its own installation directory.
 *
 *   - Windows: Windows Terminal (`wt.exe`) when available, otherwise a new
 *     PowerShell console window (detached → its own window).
 *   - macOS: a new Terminal.app window via AppleScript.
 *   - Linux: best-effort — gnome-terminal, konsole, xfce4-terminal, xterm.
 *
 * The launch is best-effort: if nothing can spawn a window the caller gets
 * `false` and falls back to running in the current terminal.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { c } from './colors.ts';

/** Escape a path for use inside a single-quoted PowerShell string. */
function psQuote(path: string): string {
  return path.replace(/'/g, "''");
}

/** Escape a path for use inside a double-quoted shell string (bash/sh). */
function shQuote(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

/**
 * Launch a new terminal window running `grace` in `root`. Resolves true when
 * a window was spawned, false when it could not be launched.
 */
export function launchInNewWindow(root: string): Promise<boolean> {
  const node = process.execPath;
  // The running entry: src/index.ts (dev) or dist/index.js (installed). It may
  // be relative, and the new window starts in the USER's workspace — resolve it
  // against the original working directory so it never breaks (and never points
  // at Grace's own install dir by accident).
  const rawEntry = process.argv[1];
  if (!rawEntry) return Promise.resolve(false);
  const entry = resolve(rawEntry);

  // The same REPL command, no --new-window (avoid infinite relaunch loops).
  const runCmd = `& '${psQuote(node)}' '${psQuote(entry)}'`;

  if (process.platform === 'win32') return launchWindows(root, runCmd);
  if (process.platform === 'darwin') return launchMac(root, runCmd);
  return launchLinux(root, runCmd);
}

function launchWindows(root: string, runCmd: string): Promise<boolean> {
  // PowerShell command: hop into the workspace, then start grace.
  const ps = `Set-Location -LiteralPath '${psQuote(root)}'; ${runCmd}`;

  // Prefer Windows Terminal: `wt -d <dir>` opens a tab rooted at the workspace.
  return trySpawn('wt.exe', ['-d', root, 'powershell', '-NoExit', '-Command', ps]).then((ok) => {
    if (ok) return true;
    // Fallback: a detached PowerShell console window (its own window on Windows).
    return trySpawn('powershell.exe', ['-NoExit', '-Command', ps]);
  });
}

function launchMac(root: string, runCmd: string): Promise<boolean> {
  const script =
    `tell application "Terminal" to do script "cd \\"${shQuote(root)}\\" && ${runCmd}"`;
  return trySpawn('osascript', ['-e', script]);
}

function launchLinux(root: string, runCmd: string): Promise<boolean> {
  const shell = `cd "${shQuote(root)}" && ${runCmd}`;
  const candidates: ReadonlyArray<{ bin: string; args: (dir: string, cmd: string) => string[] }> = [
    { bin: 'gnome-terminal', args: (dir, cmd) => ['--working-directory=' + dir, '--', 'bash', '-lc', cmd] },
    { bin: 'konsole', args: (dir, cmd) => ['--workdir', dir, '-e', 'bash', '-lc', cmd] },
    { bin: 'xfce4-terminal', args: (dir, cmd) => ['--working-directory=' + dir, '-e', `bash -lc "${cmd}"`] },
    { bin: 'xterm', args: (_dir, cmd) => ['-e', 'bash', '-lc', cmd] },
  ];

  const tryNext = (index: number): Promise<boolean> => {
    if (index >= candidates.length) return Promise.resolve(false);
    const candidate = candidates[index] as (typeof candidates)[number];
    return trySpawn(candidate.bin, candidate.args(root, shell)).then((ok) => (ok ? true : tryNext(index + 1)));
  };
  return tryNext(0);
}

/** Spawn a process detached with output ignored; resolves true on spawn. */
function trySpawn(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Human note printed when launching a new window. */
export function newWindowNotice(root: string): string {
  return `${c.green('Opening a new window for:')} ${c.blue(root)}`;
}
