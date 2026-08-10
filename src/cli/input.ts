/**
 * Terminal input helpers (Milestone 11).
 *
 * `promptHidden` reads a line without echoing it to the terminal, used for
 * passwords during `grace login/register`. Falls back to an empty string in
 * non-TTY contexts (CI) so callers can handle it gracefully.
 */
import { stdin, stdout } from 'node:process';

/** Read a visible line of input (email, names). */
export async function promptText(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a line without echoing (passwords). Empty string when not a TTY. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      resolve('');
      return;
    }
    let value = '';
    let done = false;

    const cleanup = () => {
      done = true;
      try {
        stdin.setRawMode(false);
      } catch {
        // not a TTY — nothing to restore
      }
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const finish = (result: string) => {
      if (done) return;
      cleanup();
      stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish(value);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C — cancel
          finish('');
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
        stdout.write('*');
      }
    };

    try {
      stdin.setRawMode(true);
    } catch {
      resolve('');
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    stdout.write(question);
    stdin.on('data', onData);
  });
}
