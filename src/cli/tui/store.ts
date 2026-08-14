/**
 * TUI store (GRACE full-screen interface).
 *
 * A single mutable state object + subscriber list. React components subscribe
 * via `useSyncExternalStore`; every mutation bumps `version` and notifies.
 * All interactive logic (input editing, history, scrolling, overlays) lives
 * here so it is pure, unit-testable and independent of the renderer.
 */
import type {
  ActivityItem,
  ActivityKind,
  FocusTarget,
  LoginField,
  LoginState,
  PaletteState,
  PermissionState,
  PickerKind,
  PickerOption,
  PickerState,
  SlashCommandDef,
  TuiInfo,
} from './types.ts';

/** Cap on activity lines — oldest lines drop to keep the TUI responsive. */
const MAX_ACTIVITY = 2_000;

let nextId = 1;

export class TuiStore {
  private listeners = new Set<() => void>();
  private versionValue = 0;

  // -- layout / mode ---------------------------------------------------------
  /** 'home' shows the branded startup screen; 'session' shows the activity log. */
  mode: 'home' | 'session' = 'home';
  focus: FocusTarget = 'input';

  // -- input -----------------------------------------------------------------
  input = '';
  cursor = 0;
  history: string[] = [];
  private historyIndex = -1;

  // -- activity --------------------------------------------------------------
  items: ActivityItem[] = [];
  /** True while an agent task is running. */
  busy = false;
  /** Lines scrolled up from the bottom; 0 = following the latest output. */
  scroll = 0;
  /** Files the running task has changed (real, from file-changed events). */
  changedFiles: string[] = [];
  private toolCalls = 0;

  // -- overlays --------------------------------------------------------------
  permission: PermissionState | null = null;
  picker: PickerState | null = null;
  palette: PaletteState | null = null;
  helpOpen = false;
  login: LoginState | null = null;

  // -- runtime facts ---------------------------------------------------------
  info: TuiInfo;

  /** Timestamp the current task started (real). */
  taskStartedAt: number | null = null;

  constructor(info: TuiInfo) {
    this.info = info;
  }

  // -------------------------------------------------------------------------
  // Subscription (React useSyncExternalStore)
  // -------------------------------------------------------------------------

  getVersion = (): number => {
    return this.versionValue;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  notify(): void {
    this.versionValue += 1;
    for (const l of this.listeners) l();
  }

  /** Force a redraw (Ctrl+R). */
  refresh(): void {
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Input editing (real text editing — cursor, backspace, delete, history)
  // -------------------------------------------------------------------------

  insert(ch: string): void {
    if (!ch) return;
    this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
    this.cursor += ch.length;
    this.syncPalette();
    this.notify();
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
    this.cursor -= 1;
    this.syncPalette();
    this.notify();
  }

  delete(): void {
    if (this.cursor >= this.input.length) return;
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
    this.syncPalette();
    this.notify();
  }

  moveLeft(): void {
    if (this.cursor > 0) {
      this.cursor -= 1;
      this.notify();
    }
  }

  moveRight(): void {
    if (this.cursor < this.input.length) {
      this.cursor += 1;
      this.notify();
    }
  }

  home(): void {
    if (this.cursor !== 0) {
      this.cursor = 0;
      this.notify();
    }
  }

  end(): void {
    if (this.cursor !== this.input.length) {
      this.cursor = this.input.length;
      this.notify();
    }
  }

  clearInput(): void {
    if (this.input === '' && this.palette === null) return;
    this.input = '';
    this.cursor = 0;
    this.closePalette();
    this.historyIndex = -1;
    this.notify();
  }

  setInput(text: string): void {
    this.input = text;
    this.cursor = text.length;
    this.historyIndex = -1;
    this.syncPalette();
    this.notify();
  }

  /** Commit the current line to history and reset the input. */
  submitInput(): void {
    const text = this.input.trim();
    if (text) {
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    }
    this.historyIndex = -1;
    this.input = '';
    this.cursor = 0;
    this.closePalette();
    this.notify();
  }

  historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    this.input = this.history[this.historyIndex] ?? '';
    this.cursor = this.input.length;
    this.syncPalette();
    this.notify();
  }

  historyDown(): void {
    if (this.historyIndex === -1) return;
    this.historyIndex += 1;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      this.input = '';
    } else {
      this.input = this.history[this.historyIndex] ?? '';
    }
    this.cursor = this.input.length;
    this.syncPalette();
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Activity feed + scrolling
  // -------------------------------------------------------------------------

  /**
   * Push one or more activity lines. Multi-line text is split into individual
   * lines so the scroll math and rendering stay line-based.
   */
  push(kind: ActivityKind, text: string): void {
    if (!text) return;
    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r/g, '').trimEnd();
      if (line === '') continue;
      this.items.push({ id: nextId++, kind, text: line });
    }
    if (this.items.length > MAX_ACTIVITY) {
      this.items.splice(0, this.items.length - MAX_ACTIVITY);
    }
    // Following the bottom stays at the bottom automatically (scroll 0).
    this.notify();
  }

  clearActivity(): void {
    this.items = [];
    this.scroll = 0;
    this.changedFiles = [];
    this.toolCalls = 0;
    this.mode = 'home';
    this.notify();
  }

  scrollUp(lines: number): void {
    const maxScroll = this.items.length - 1;
    if (maxScroll <= 0) return;
    this.scroll = Math.min(maxScroll, this.scroll + lines);
    this.notify();
  }

  scrollDown(lines: number): void {
    this.scroll = Math.max(0, this.scroll - lines);
    this.notify();
  }

  scrollToBottom(): void {
    if (this.scroll !== 0) {
      this.scroll = 0;
      this.notify();
    }
  }

  toggleFocus(): void {
    this.focus = this.focus === 'input' ? 'activity' : 'input';
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Task lifecycle
  // -------------------------------------------------------------------------

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (busy) this.taskStartedAt = Date.now();
    else this.taskStartedAt = null;
    this.notify();
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  recordChangedFile(path: string): void {
    if (!this.changedFiles.includes(path)) this.changedFiles.push(path);
  }

  // -------------------------------------------------------------------------
  // Permission dialog
  // -------------------------------------------------------------------------

  /** Open the permission dialog; resolves when the user answers y/n/a. */
  askPermission(command: string, reasons: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      this.permission = { id: nextId++, command, reasons, resolve };
      this.notify();
    });
  }

  answerPermission(allowed: boolean): void {
    const p = this.permission;
    if (!p) return;
    this.permission = null;
    p.resolve(allowed);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Pickers (model / provider)
  // -------------------------------------------------------------------------

  openPicker(kind: PickerKind, title: string, options: PickerOption[], onSelect: (opt: PickerOption, index: number) => void, onCancel: () => void): void {
    this.picker = { id: nextId++, title, options, all: options, filter: '', selected: Math.max(0, options.findIndex((o) => o.current)), onSelect, onCancel };
    this.notify();
  }

  pickerFilter(query: string): void {
    const p = this.picker;
    if (!p) return;
    p.filter = query;
    p.options = p.all.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
    if (p.selected >= p.options.length) p.selected = Math.max(0, p.options.length - 1);
    this.notify();
  }

  pickerMove(delta: number): void {
    const p = this.picker;
    if (!p || p.options.length === 0) return;
    p.selected = (p.selected + delta + p.options.length) % p.options.length;
    this.notify();
  }

  pickerSelect(): void {
    const p = this.picker;
    if (!p) return;
    const opt = p.options[p.selected];
    if (!opt || opt.disabled) return;
    const index = p.selected;
    this.picker = null;
    p.onSelect(opt, index);
  }

  closePicker(): void {
    const p = this.picker;
    this.picker = null;
    p?.onCancel();
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Command palette
  // -------------------------------------------------------------------------

  /** Open (or keep) the palette for a slash-prefixed input. */
  syncPalette(): void {
    if (this.input.startsWith('/') && this.input.length >= 1) {
      if (!this.palette) {
        this.palette = { commands: [], query: '', selected: 0 };
        this.notify();
      }
      this.palette.query = this.input;
    } else {
      this.closePalette();
    }
  }

  /** Refresh palette entries (called with the real command table). */
  setPaletteCommands(commands: SlashCommandDef[]): void {
    if (!this.palette) return;
    this.palette.commands = commands;
    this.notify();
  }

  paletteMove(delta: number): void {
    const p = this.palette;
    if (!p || p.commands.length === 0) return;
    p.selected = (p.selected + delta + p.commands.length) % p.commands.length;
    this.notify();
  }

  /**
   * Visible palette rows for the current query. Matches on the FIRST token so
   * "/model groq" still highlights /model while keeping typed args intact.
   */
  paletteRows(): SlashCommandDef[] {
    if (!this.palette) return [];
    const raw = this.palette.query.startsWith('/') ? this.palette.query.slice(1) : this.palette.query;
    const query = (raw.split(/\s+/)[0] ?? '').toLowerCase();
    const rows = query
      ? this.palette.commands.filter((c) => c.name.toLowerCase().startsWith('/' + query))
      : this.palette.commands;
    return rows.slice(0, 10);
  }

  closePalette(): void {
    if (this.palette) {
      this.palette = null;
      this.notify();
    }
  }

  // -------------------------------------------------------------------------
  // Help overlay
  // -------------------------------------------------------------------------

  openHelp(): void {
    this.helpOpen = true;
    this.notify();
  }

  closeHelp(): void {
    this.helpOpen = false;
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Login/register overlay
  // -------------------------------------------------------------------------

  openLogin(purpose: 'login' | 'register', emailArg: string): void {
    this.login = {
      purpose,
      email: emailArg.trim() ?? '',
      field: 'email',
      password: '',
      confirm: '',
      busy: false,
    };
    this.notify();
  }

  loginType(ch: string): void {
    const l = this.login;
    if (!l || l.busy) return;
    const field: LoginField = l.field;
    if (field === 'email') l.email += ch;
    else if (field === 'password') l.password += ch;
    else l.confirm += ch;
    this.notify();
  }

  loginBackspace(): void {
    const l = this.login;
    if (!l || l.busy) return;
    if (l.field === 'email') l.email = l.email.slice(0, -1);
    else if (l.field === 'password') l.password = l.password.slice(0, -1);
    else l.confirm = l.confirm.slice(0, -1);
    this.notify();
  }

  loginNextField(): void {
    const l = this.login;
    if (!l || l.busy) return;
    if (l.field === 'email') l.field = 'password';
    else if (l.field === 'password') l.field = l.purpose === 'register' ? 'confirm' : 'email';
    else l.field = 'email';
    this.notify();
  }

  loginSetField(field: LoginField): void {
    const l = this.login;
    if (!l) return;
    l.field = field;
    this.notify();
  }

  loginError(error: string): void {
    const l = this.login;
    if (!l) return;
    l.error = error;
    l.busy = false;
    this.notify();
  }

  loginBusy(): void {
    const l = this.login;
    if (!l) return;
    l.busy = true;
    l.error = undefined;
    this.notify();
  }

  closeLogin(): void {
    this.login = null;
    this.notify();
  }
}
