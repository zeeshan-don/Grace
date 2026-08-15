/**
 * TUI task runner (GRACE full-screen interface).
 *
 * The presentation-layer counterpart of src/cli/taskRunner.ts: routes a task
 * through the SAME agent machinery (fast router → coordinator → primary agent
 * → tools) but renders into the TUI activity feed instead of stdout, and
 * surfaces permission requests as interactive dialogs.
 *
 * All output is pushed through the store as ANSI-free lines; the React layer
 * applies colors by kind. Chain-of-thought is never rendered — only concise
 * action summaries and tool activity.
 */
import { Coordinator } from '../../agents/coordinator.ts';
import { classifyTask, conversationReply } from '../../agents/fastRouter.ts';
import { RoleModelRouter } from '../../agents/roleRouter.ts';
import type { CoordinatorEvent } from '../../agents/types.ts';
import { TaskCancelledError } from '../../agent/loop.ts';
import { reportRunUsage } from '../../auth/reporting.ts';
import { ApiClient, ApiError } from '../../auth/client.ts';
import { loadSession, saveSession, sessionExpired } from '../../auth/session.ts';
import { zeeshApiUrl } from '../../config/config.ts';
import { ProjectIndexService } from '../../project/index.ts';
import { RemoteProvider } from '../../providers/remote.ts';
import type { Runtime } from '../../runtime.ts';
import { stripAnsi } from '../ui/theme.ts';
import { renderError, renderTaskResult } from '../ui/results.ts';
import { sessionRolloverNote, sessionStatusLine } from '../freePlan.ts';
import { isVerbose } from '../verbose.ts';
import { applyModelSelection, applyProviderSelection, discoverModels, discoverProviders } from './models.ts';
import type { TuiStore } from './store.ts';
import type { PickerOption } from './types.ts';
import { buildTuiInfo } from './info.ts';

/** Human-friendly rendering of a tool call (no raw JSON). */
export function friendlyTool(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file': {
      const p = String(args.path ?? '');
      return p ? `Reading ${p}` : 'Reading a file';
    }
    case 'write_file': {
      const p = String(args.path ?? '');
      return p ? `Writing ${p}` : 'Writing a file';
    }
    case 'edit_file': {
      const p = String(args.path ?? '');
      return p ? `Editing ${p}` : 'Editing a file';
    }
    case 'search_files': {
      const q = String(args.query ?? args.pattern ?? '');
      return q ? `Searching files · query: ${q}` : 'Searching files';
    }
    case 'list_directory': {
      const p = String(args.path ?? '');
      return p && p !== '.' ? `Listing directory ${p}` : 'Listing directory';
    }
    case 'run_command': {
      const cmd = String(args.command ?? '');
      return cmd ? `Running ${cmd}` : 'Running a command';
    }
    case 'git_diff':
      return 'Checking git diff';
    case 'web_fetch': {
      const url = String(args.url ?? '');
      return url ? `Fetching ${url}` : 'Fetching a URL';
    }
    default:
      return tool;
  }
}

/** Drop the raw "→ tool {...}" status lines — tool-start events render cleaner. */
function isToolStatus(message: string): boolean {
  return /^→ \S+ /.test(message.trim());
}

/** Status lines with no user value (mirrors the console ProgressRenderer). */
function isNoise(message: string): boolean {
  const m = message.trim();
  return m === 'Thinking…' || m === 'Thinking...' || /^Done in \d+ iteration/.test(m) || /^    ⚙ /.test(m);
}

export interface TuiRunnerOptions {
  runtime: Runtime;
  store: TuiStore;
  /** Called when the user requests an exit (/exit, Ctrl+C while idle). */
  onExit: () => void;
  /** Rebuild the runtime for a new workspace (mirrors the REPL). */
  makeRuntime: (root: string) => Runtime;
}

export class TuiRunner {
  private readonly store: TuiStore;
  private readonly onExit: () => void;
  readonly makeRuntime: (root: string) => Runtime;
  private readonly indexByRuntime = new WeakMap<object, ProjectIndexService>();
  private abort: AbortController | null = null;
  private approvedPrefixes = new Set<string>();
  private taskRunning = false;
  private runtime: Runtime;

  constructor(opts: TuiRunnerOptions) {
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.onExit = opts.onExit;
    this.makeRuntime = opts.makeRuntime;
  }

  /** The current runtime (swapped by /cd). */
  getRuntime(): Runtime {
    return this.runtime;
  }

  /** Whether an agent task is in flight (Ctrl+C cancels instead of exiting). */
  isBusy(): boolean {
    return this.taskRunning;
  }

  cancelTask(): void {
    this.abort?.abort();
    this.store.push('info', 'Cancel requested — stopping…');
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  /** Route and run one user task (conversation / tests / coding / inspect). */
  async runTask(input: string): Promise<void> {
    const store = this.store;
    const runtime = this.runtime;

    store.push('user', input);
    store.mode = 'session';
    // A new task always follows the newest output: if the user scrolled up
    // inspecting the previous run, drop back to the bottom so this run's
    // output (and the input line) are immediately visible.
    store.scrollToBottom();

    const route = classifyTask(input).route;
    if (route === 'conversation') {
      store.push('system', conversationReply(input));
      return;
    }

    if (!runtime.provider) {
      store.push('error', stripAnsi(renderError(runtime.providerError ?? 'No AI provider configured.')));
      return;
    }

    let index = this.indexByRuntime.get(runtime);
    if (!index) {
      index = new ProjectIndexService(runtime.root);
      this.indexByRuntime.set(runtime, index);
    }

    const startedAt = Date.now();
    store.setBusy(true);
    this.taskRunning = true;
    const controller = new AbortController();
    this.abort = controller;

    try {
      const roleRouter = new RoleModelRouter(runtime);
      const verbose = isVerbose();
      const coordinator = new Coordinator({
        runtime,
        projectIndex: index,
        onEvent: (e) => this.handleCoordinatorEvent(e),
        providerFactory: (role, spec) => (role === 'editor' ? runtime.provider : roleRouter.providerFor(role, spec)),
        plannerProvider: roleRouter.plannerProvider(),
        signal: controller.signal,
      });

      let result: Awaited<ReturnType<Coordinator['run']>>;
      try {
        result = await coordinator.run(input);
      } catch (err) {
        if (err instanceof TaskCancelledError) {
          store.push('info', 'Cancelled.');
          return;
        }
        store.push('error', stripAnsi(renderError('Task failed', (err as Error).message ?? String(err))));
        return;
      }

      if (result.changedFiles.length > 0) index.invalidate();
      if (result.route === 'conversation') {
        store.push('system', result.finalAnswer);
        return;
      }

      const executionTimeMs = Date.now() - startedAt;
      store.push('result', stripAnsi(renderTaskResult({ result, runtime, executionTimeMs, verbose })));

      // GRACE FREE: quota from the server's latest response (real state).
      // Shown for ANY logged-in account — the free plan belongs to the
      // account, not to how requests are transported (local key or backend).
      const stored = loadSession();
      if (stored && !sessionExpired(stored)) {
        const last = RemoteProvider.sharedSession();
        if (last) {
          const line = sessionStatusLine(last);
          if (line) store.push('info', stripAnsi(line));
          if (last.startedNew) store.push('info', stripAnsi(sessionRolloverNote(last)));
        }
      }

      void reportRunUsage({
        prompt: input,
        model: runtime.provider!.getModel().id,
        projectType: runtime.project.type,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        usage: result.usage,
        executionTimeMs,
      }).then((outcome) => {
        if (outcome === 'failed') store.push('console', 'usage report failed (backend offline) — run continued locally.');
      });
    } finally {
      this.taskRunning = false;
      this.abort = null;
      store.setBusy(false);
    }
  }

  /**
   * Map a coordinator event into activity feed lines (never chain-of-thought).
   *
   * Normal mode shows only the spinner ("Grace is working…") plus genuine
   * user-relevant events (permission decisions, completion, quota). Internal
   * activity — planning, tool calls, progress status lines — is debug/verbose
   * only, exactly like the classic ProgressRenderer.
   */
  private handleCoordinatorEvent(e: CoordinatorEvent): void {
    const store = this.store;
    const verbose = isVerbose();
    switch (e.type) {
      case 'planning':
        if (verbose) store.push('info', 'Planning…');
        break;
      case 'status':
        if (!verbose) break;
        if (isToolStatus(e.message) || isNoise(e.message)) break;
        store.push('progress', e.message);
        break;
      case 'tool-start':
        if (verbose) store.push('tool', friendlyTool(e.tool, e.args));
        store.recordToolCall();
        break;
      case 'tool-end':
        if (verbose && !e.ok) store.push('error', `${e.tool} failed`);
        break;
      case 'file-changed':
        store.recordChangedFile(e.path);
        break;
      case 'permission-request':
        // The ask() call opens the dialog; the activity line documents it.
        store.push('info', `Permission needed: ${e.command}`);
        break;
      case 'permission-result':
        if (e.allowed) store.push('success', `Allowed: ${e.command}`);
        else store.push('info', `Denied: ${e.command}`);
        break;
      case 'agent-done':
        if (e.role !== 'editor') break;
        if (e.status === 'completed') store.push('success', e.summary || 'Done.');
        else if (e.status === 'failed') store.push('error', e.error ?? e.summary);
        else store.push('info', e.summary);
        break;
      default:
        break;
    }
  }

  /** The permission hook wired into the runtime: opens the interactive dialog. */
  askPermission = (command: string, reasons: string[]): Promise<boolean> => {
    const prefix = commandPrefix(command);
    if (prefix && this.approvedPrefixes.has(prefix)) return Promise.resolve(true);
    return this.store.askPermission(command, reasons);
  };

  /** Called by the dialog when the user chose "always allow similar". */
  rememberPrefix(command: string): void {
    const prefix = commandPrefix(command);
    if (prefix) this.approvedPrefixes.add(prefix);
  }

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  /** Execute a slash command; returns true when Grace should exit. */
  async runSlash(raw: string): Promise<boolean> {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    if (!cmd) return false;
    const { handleTuiSlash } = await import('./commands-tui.ts');
    const shouldExit = await handleTuiSlash(this, this.store, cmd, arg);
    if (shouldExit) this.onExit();
    return shouldExit;
  }

  // -------------------------------------------------------------------------
  // Model / provider pickers
  // -------------------------------------------------------------------------

  async openModelPicker(): Promise<void> {
    const store = this.store;
    const runtime = this.runtime;
    if (!runtime.provider) {
      store.push('error', stripAnsi(renderError(runtime.providerError ?? 'No AI provider configured.')));
      return;
    }
    store.push('info', 'Fetching available models…');
    const options = await discoverModels(runtime);
    if (options.length === 0) {
      store.push('info', 'Could not list models for this provider — set one directly with /model <id>.');
      return;
    }
    store.openPicker(
      'model',
      'Models',
      options,
      (opt) => {
        const err = applyModelSelection(runtime, opt.value);
        if (err) store.push('error', err);
        else store.push('success', `Model set to ${opt.value} (saved).`);
        this.refreshInfo();
      },
      () => undefined,
    );
  }

  openProviderPicker(): void {
    const store = this.store;
    const options = discoverProviders(this.runtime);
    if (options.length === 0) {
      store.push('info', 'No providers configured — add GROQ_API_KEY to .env or run /login to use the GRACE backend.');
      return;
    }
    store.openPicker(
      'provider',
      'Providers',
      options,
      (opt: PickerOption) => {
        const err = applyProviderSelection(this.runtime, opt.value);
        if (err) store.push('error', err);
        else store.push('success', `Provider set to ${opt.label}.`);
        this.refreshInfo();
      },
      () => undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Login / register (real backend calls through the overlay)
  // -------------------------------------------------------------------------

  /** Submit the login/register form with the overlay's real values. */
  async submitAuth(): Promise<void> {
    const store = this.store;
    const login = store.login;
    if (!login || login.busy) return;
    store.loginBusy();

    const email = login.email.trim();
    const password = login.password;

    if (!email || !password) {
      store.loginError('Email and password are required.');
      return;
    }
    if (login.purpose === 'register' && password.length < 8) {
      store.loginError('Password must be at least 8 characters.');
      return;
    }
    if (login.purpose === 'register' && password !== login.confirm) {
      store.loginError('Passwords do not match.');
      return;
    }

    // Configuration only (ZEESH_API_URL override, else the deployed backend)
    // — a stale stored session never redirects login to an old dev backend.
    const apiUrl = zeeshApiUrl();
    const api = new ApiClient(apiUrl);
    try {
      const result = login.purpose === 'login' ? await api.login(email, password) : await api.register(email, password);
      saveSession({
        apiUrl,
        token: result.token,
        user: { id: result.user.id, email: result.user.email, displayName: result.user.display_name },
        expiresAt: result.expires_at,
        createdAt: new Date().toISOString(),
      });
      store.closeLogin();
      store.push('success', login.purpose === 'login' ? `Logged in as ${result.user.email}.` : `Account created — logged in as ${result.user.email}.`);
      this.refreshInfo();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        store.loginError('Invalid email or password. No account yet? Try /register.');
      } else if (err instanceof ApiError && err.status === 429) {
        store.loginError(`Too many attempts — try again in ${err.retryAfterSeconds ?? 60}s.`);
      } else if (err instanceof ApiError && err.status === 409) {
        store.loginError('An account with this email already exists. Try /login.');
      } else if (err instanceof ApiError && err.status === 403) {
        store.loginError(err.message);
      } else {
        store.loginError(err instanceof Error ? err.message : 'Request failed.');
      }
    }
  }

  /** Rebuild the TUI info snapshot (after model/provider/auth changes). */
  refreshInfo(): void {
    this.store.info = buildTuiInfo(this.runtime, this.store.info.freePlan);
    this.store.notify();
  }

  /** Replace the runtime (used by /cd). */
  setRuntime(runtime: Runtime): void {
    this.runtime = runtime;
  }
}

/** First word of a command (same rule as the REPL's always-allow memory). */
function commandPrefix(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^a-zA-Z0-9._-]/g, '');
}
