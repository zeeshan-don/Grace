/**
 * Grace progress rendering (GRACE UI — primary-agent UX).
 *
 * Turns coordinator events into concise, non-chain-of-thought progress:
 *
 *   Grace · NVIDIA NIM · qwen/qwen2.5-coder-32b-instruct
 *
 *   · Grace is working…
 *   • → read_file src/auth/login.ts
 *   • → edit_file src/auth/login.ts
 *   • → run_command npm test
 *   → Grace ✓ — Authentication added
 *
 * - One line per meaningful event: the provider header, a live working line
 *   (`· Grace is working…` / `· Thinker…`), settled status bullets and one
 *   settled line per finished agent.
 * - The working line is redrawn in place with a subtle spinner on TTY; on
 *   plain/piped output every line is printed deterministically as it settles.
 * - A greeting ("hi") renders nothing at all — the reply is printed directly.
 */
import type { CoordinatorEvent } from '../../agents/types.ts';
import type { SubagentResult } from '../../agents/types.ts';
import { supportsAnsi, symbols, theme, visualWidth, type Symbols, type Theme } from './theme.ts';

export interface ProgressRendererOptions {
  /** Output sink (defaults to process.stdout). */
  out?: { write(text: string): void };
  /** Force live redraw on/off (default: TTY stdout + ANSI support). */
  live?: boolean;
  /** Show step headers (verbose diagnostics). */
  verbose?: boolean;
  /** Terminal width used for wrap-aware redraw (default stdout.columns). */
  columns?: number;
  /** Provider + model shown once, e.g. "Grace · NVIDIA NIM · qwen/…". */
  providerLabel?: string;
  model?: string;
}

const SPINNER_MS = 120;

/** Collapse a summary to a single line, capped for the progress list. */
function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** Status messages that carry no user value in the progress block. */
function isNoise(message: string): boolean {
  const m = message.trim();
  return m === 'Thinking…' || m === 'Thinking...' || /^Done in \d+ iteration/.test(m) || /^    ⚙ /.test(m);
}

export class ProgressRenderer {
  private readonly out: (text: string) => void;
  /** Live redraw — may flip to false when the block settles to plain output. */
  private live: boolean;
  private readonly verbose: boolean;
  private readonly columns: number;
  private readonly sym: Symbols;
  private readonly th: Theme;
  private readonly providerLine?: string;

  /** Conversation route: nothing is rendered (the reply prints directly). */
  private suppressed = false;
  private headerPrinted = false;
  private planning?: string;
  private stepHeader?: string;
  /** The live working line (not yet settled). */
  private current?: string;
  /** Lines of fully-settled events (printed when not live). */
  private settled: string[] = [];
  private paintedRows = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  /** Above this many rows the live block is settled to plain output. */
  private static readonly MAX_LIVE_ROWS = 12;

  constructor(opts: ProgressRendererOptions = {}) {
    this.out = opts.out?.write ? opts.out.write.bind(opts.out) : (text) => process.stdout.write(text);
    this.live = opts.live ?? (Boolean(process.stdout.isTTY) && supportsAnsi());
    this.verbose = opts.verbose ?? false;
    this.columns = opts.columns ?? process.stdout.columns ?? 80;
    this.sym = symbols();
    this.th = theme();
    this.providerLine =
      opts.providerLabel && opts.model
        ? `  ${this.th.dim(`Grace ${this.sym.bullet} ${opts.providerLabel} ${this.sym.bullet} ${opts.model}`)}`
        : undefined;
  }

  /** Feed a coordinator event. */
  event(evt: CoordinatorEvent): void {
    if (this.suppressed) return;
    switch (evt.type) {
      case 'route':
        if (evt.route === 'conversation') {
          this.suppressed = true;
        }
        break;
      case 'planning':
        this.planning = `  ${this.th.dim(`${this.sym.bullet} Planning${this.sym.ellipsis}`)}`;
        if (!this.live) this.print(`${this.planning}\n`);
        else this.paint();
        break;
      case 'working':
        this.setCurrent(`  ${this.th.dim(`${this.sym.bullet} Grace is working${this.sym.ellipsis}`)}`);
        break;
      case 'status':
        if (isNoise(evt.message)) break;
        this.addSettled(`  ${this.sym.dot} ${evt.message}`);
        break;
      case 'step-start':
        this.flushCurrent();
        this.stepHeader = this.verbose ? `  ${this.th.dim(`Step ${evt.step}/${evt.total}`)}` : undefined;
        if (this.stepHeader && !this.live) this.print(`${this.stepHeader}\n`);
        else this.paint();
        break;
      case 'agent-start':
        // The primary agent (Grace) is covered by the 'working' line — only
        // specialist agents get their own start line.
        if (evt.role !== 'editor') {
          this.setCurrent(`  ${this.th.dim(`${this.sym.bullet} ${evt.label}${this.sym.ellipsis}`)}`);
        }
        break;
      case 'agent-done':
        this.setCurrent(undefined);
        this.addSettled(`  ${this.sym.arrow} ${this.renderDone(evt)}`);
        break;
      case 'done':
        this.flushCurrent();
        this.paint();
        break;
    }
  }

  /** Finish the run: settle any leftovers and stop the spinner. */
  end(): void {
    this.flushCurrent();
    this.stopSpinner();
    this.paint();
  }

  private ensureHeader(): void {
    if (this.headerPrinted) return;
    this.headerPrinted = true;
    if (this.providerLine) this.print(`${this.providerLine}\n`);
  }

  private print(text: string): void {
    this.ensureHeader();
    this.out(text);
  }

  /** A line settles: printed immediately in plain mode, painted in live mode. */
  private addSettled(line: string): void {
    this.settled.push(line);
    this.stopSpinner();
    if (!this.live) this.print(`${line}\n`);
    else this.paint();
  }

  private setCurrent(line: string | undefined): void {
    this.current = line;
    if (line) this.ensureSpinner();
    else this.stopSpinner();
    if (!this.live) {
      if (line) this.print(`${line}\n`);
    } else {
      this.paint();
    }
  }

  private flushCurrent(): void {
    this.current = undefined;
    this.stopSpinner();
  }

  /** The full logical progress block (header + planning + settled + current). */
  private renderAll(): string[] {
    const lines: string[] = [];
    if (this.providerLine) lines.push(this.providerLine);
    if (this.planning) lines.push(this.planning);
    if (this.stepHeader) lines.push(this.stepHeader);
    lines.push(...this.settled);
    if (this.current) lines.push(this.current);
    return lines;
  }

  /** "Label ✓ — summary" (or ✗ / !) once an agent finished. */
  private renderDone(evt: Extract<CoordinatorEvent, { type: 'agent-done' }>): string {
    const { sym, th } = this;
    const mark =
      evt.status === 'completed'
        ? th.success(sym.check)
        : evt.status === 'failed'
          ? th.error(sym.cross)
          : th.warn(sym.warn);
    const text = evt.status === 'completed' ? evt.summary : evt.status === 'failed' ? (evt.error ?? evt.summary) : evt.summary;
    const detail = text ? ` ${th.dim(`— ${oneLiner(text)}`)}` : '';
    return `${th.agent(evt.label)} ${mark}${detail}`;
  }

  // -------------------------------------------------------------------------
  // Live TTY redraw + spinner
  // -------------------------------------------------------------------------

  /** Redraw the progress block in place (live mode only). */
  private paint(): void {
    if (!this.live) return;
    const lines = this.renderAll();
    const rows = lines.reduce((acc, line) => acc + Math.max(1, Math.ceil(visualWidth(line) / this.columns)), 0);
    // A block taller than the viewport estimate would scroll mid-redraw and
    // leave stale rows — settle it as plain, deterministic output instead.
    if (rows > ProgressRenderer.MAX_LIVE_ROWS) {
      this.settleToPlain(lines);
      return;
    }
    try {
      if (this.paintedRows > 0) {
        this.out(`\x1b[${this.paintedRows}A`);
        for (let i = 0; i < this.paintedRows; i += 1) this.out('\x1b[2K\x1b[1B');
        this.out(`\x1b[${this.paintedRows}A`);
      }
      if (lines.length > 0) this.out(`${lines.join('\n')}\n`);
      this.paintedRows = rows;
    } catch {
      // Terminal rejected the redraw — settle plainly so nothing is lost.
      this.settleToPlain(lines);
    }
  }

  /** Permanently print the whole block and stop live redrawing. */
  private settleToPlain(lines: string[]): void {
    this.live = false;
    this.paintedRows = 0;
    this.stopSpinner();
    for (const line of lines) this.out(`${line}\n`);
    this.planning = undefined;
    this.stepHeader = undefined;
    this.settled = [];
    this.current = undefined;
  }

  private ensureSpinner(): void {
    if (!this.live || this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.frame += 1;
      this.paint();
    }, SPINNER_MS);
    // Never keep the process alive just for the spinner.
    if (typeof this.spinnerTimer.unref === 'function') this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }
}

export type { SubagentResult };
