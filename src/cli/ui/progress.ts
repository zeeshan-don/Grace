/**
 * Agent progress rendering (GRACE UI).
 *
 * Turns coordinator events into concise, non-chain-of-thought progress lines:
 *
 *   · Planning…
 *   → Project Scout ✓ — mapped the repository
 *   → File Picker ✓ — 3 relevant files
 *   → Editor ✓ — implemented the change
 *   ┌─ Test Runner ✓ — 215/215 tests passed
 *   └─ Code Reviewer ✓ — no critical issues
 *
 * - Agent lines only ever show: name, status mark, one-line summary.
 * - Agents that ran in parallel inside one coordinator step are drawn as a
 *   small tree (┌─ / └─); single-agent steps are flat → lines.
 * - In a real terminal the pending block is redrawn in place with a subtle
 *   rotating spinner; on plain/piped output the same final lines are printed
 *   deterministically (every line is settled before the run finishes).
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
}

type AgentStatus = SubagentResult['status'] | 'running';

interface StepAgent {
  label: string;
  status: AgentStatus;
  summary?: string;
  error?: string;
}

const SPINNER_MS = 120;

/** Collapse a summary to a single line, capped for the progress list. */
function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

export class ProgressRenderer {
  private readonly out: (text: string) => void;
  /** Live redraw — may flip to false when the block settles to plain output. */
  private live: boolean;
  private readonly verbose: boolean;
  private readonly columns: number;
  private readonly sym: Symbols;
  private readonly th: Theme;

  private planning?: string;
  private stepHeader?: string;
  /** Agents of the step currently executing (insertion order). */
  private step = new Map<string, StepAgent>();
  /** Lines of fully-settled steps (already printed when not live). */
  private blocks: string[] = [];
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
  }

  /** Feed a coordinator event. */
  event(evt: CoordinatorEvent): void {
    switch (evt.type) {
      case 'planning':
        this.planning = `  ${this.th.dim(`${this.sym.bullet} Planning${this.sym.ellipsis}`)}`;
        if (!this.live) this.out(`${this.planning}\n`);
        else this.paint();
        break;
      case 'step-start':
        this.flushStep();
        this.stepHeader = this.verbose ? `  ${this.th.dim(`Step ${evt.step}/${evt.total}`)}` : undefined;
        if (this.stepHeader && !this.live) this.out(`${this.stepHeader}\n`);
        else this.paint();
        break;
      case 'agent-start':
        this.step.set(evt.label, { label: evt.label, status: 'running' });
        this.ensureSpinner();
        this.paint();
        break;
      case 'agent-done':
        this.step.set(evt.label, {
          label: evt.label,
          status: evt.status,
          summary: evt.summary,
          error: evt.error,
        });
        if (this.allDone()) this.flushStep();
        else this.paint();
        break;
      case 'done':
        this.flushStep();
        this.paint();
        break;
    }
  }

  /** Finish the run: settle any leftovers and stop the spinner. */
  end(): void {
    this.flushStep();
    this.stopSpinner();
    this.paint();
  }

  private allDone(): boolean {
    return this.step.size > 0 && [...this.step.values()].every((a) => a.status !== 'running');
  }

  /** Permanently record the current step's block (print when not live). */
  private flushStep(): void {
    if (this.step.size === 0) return;
    const block = this.renderStep(this.step);
    this.step = new Map();
    this.stopSpinner();
    this.blocks.push(...block);
    if (!this.live) {
      for (const line of block) this.out(`${line}\n`);
    }
    this.paint();
  }

  /** The full logical progress block (planning + header + settled + current). */
  private renderAll(): string[] {
    const lines: string[] = [];
    if (this.planning) lines.push(this.planning);
    if (this.stepHeader) lines.push(this.stepHeader);
    lines.push(...this.blocks);
    if (this.step.size > 0) lines.push(...this.renderStep(this.step));
    return lines;
  }

  /** Render one step: flat arrow line, or a parallel tree. */
  private renderStep(step: Map<string, StepAgent>): string[] {
    const agents = [...step.values()];
    if (agents.length === 1) {
      const a = agents[0] as StepAgent;
      const line = a.status === 'running' ? this.renderRunning(a) : `  ${this.sym.arrow} ${this.renderDone(a)}`;
      return [line];
    }
    return agents.map((a, i) => {
      const branch =
        i === 0 ? this.sym.cornerTl : i === agents.length - 1 ? this.sym.cornerBl : this.sym.mid;
      const body = a.status === 'running' ? this.renderRunning(a) : this.renderDone(a);
      return `  ${branch}${this.sym.hLine} ${body}`;
    });
  }

  /** "· Label…" while an agent is still working. */
  private renderRunning(a: StepAgent): string {
    const { sym, th } = this;
    const glyph = this.spinnerTimer ? sym.spinner[this.frame % sym.spinner.length] : sym.bullet;
    return th.dim(`${glyph} ${a.label}${sym.ellipsis}`);
  }

  /** "Label ✓ — summary" (or ✗ / !) once the agent finished. */
  private renderDone(a: StepAgent): string {
    const { sym, th } = this;
    const mark =
      a.status === 'completed'
        ? th.success(sym.check)
        : a.status === 'failed'
          ? th.error(sym.cross)
          : th.warn(sym.warn);
    const text = a.status === 'completed' ? a.summary : a.status === 'failed' ? (a.error ?? a.summary) : a.summary;
    const detail = text ? ` ${th.dim(`— ${oneLiner(text)}`)}` : '';
    return `${th.agent(a.label)} ${mark}${detail}`;
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
    // The current content is now on screen — clear the internal state so
    // nothing is printed a second time.
    this.planning = undefined;
    this.stepHeader = undefined;
    this.blocks = [];
    this.step = new Map();
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
