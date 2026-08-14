/**
 * TUI state types (GRACE full-screen interface).
 *
 * The TUI is a presentation layer over the existing agent system: the store
 * below is the single source of truth for everything the interface renders,
 * and every value comes from real runtime state (workspace, provider, model,
 * session, live agent events). No fake numbers, no decorative state.
 */

/** What a single activity line represents (drives its Ink color). */
export type ActivityKind =
  | 'user' // the user's submitted task
  | 'system' // banner / informational
  | 'progress' // settled agent progress bullet
  | 'tool' // a tool started / is running
  | 'file' // a file was changed
  | 'success'
  | 'error'
  | 'info'
  | 'result' // final task result block
  | 'console'; // output captured from console.log (slash commands etc.)

/** One rendered line of activity (text is ALWAYS ANSI-free, single-line). */
export interface ActivityItem {
  id: number;
  kind: ActivityKind;
  text: string;
}

/** Snapshot of real runtime facts shown in the header and home screen. */
export interface TuiInfo {
  version: string;
  /** Absolute workspace directory. */
  workspace: string;
  /** Human provider label (e.g. "NVIDIA NIM", "Groq (LPU)"). */
  provider: string;
  providerAvailable: boolean;
  providerError?: string;
  model: string;
  /** "Local mode" / "dev@example.com · 12m left" / "not logged in". */
  session: string;
  /** GRACE FREE line ("Session 2/6 · 45m left") when the backend reports it. */
  freePlan?: string;
}

/** Interactive permission request — the agent is paused until resolved. */
export interface PermissionState {
  id: number;
  command: string;
  reasons: string[];
  resolve: (allowed: boolean) => void;
}

/** A selectable row in a picker (models, providers). */
export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  current?: boolean;
  disabled?: boolean;
}

/** Open picker overlay (model selector / provider selector). */
export interface PickerState {
  id: number;
  title: string;
  /** Options currently shown (after live filtering). */
  options: PickerOption[];
  /** All options (unfiltered) so filtering can reapply. */
  all: PickerOption[];
  filter: string;
  selected: number;
  onSelect: (opt: PickerOption, index: number) => void;
  onCancel: () => void;
}

/** Command palette entry — every entry is a REAL working slash command. */
export interface SlashCommandDef {
  name: string;
  usage: string;
  description: string;
}

/** Open command palette overlay. */
export interface PaletteState {
  commands: SlashCommandDef[];
  query: string;
  selected: number;
}

/** Login/register form overlay (real masked input, no readline). */
export type LoginField = 'email' | 'password' | 'confirm';

export interface LoginState {
  purpose: 'login' | 'register';
  /** Pre-filled email from `grace login <email>` style args. */
  email: string;
  field: LoginField;
  password: string;
  confirm: string;
  error?: string;
  busy: boolean;
}

/** Focus target — Tab cycles: input → shortcuts (home) / activity (session). */
export type FocusTarget = 'input' | 'shortcuts' | 'activity';

/** Picker kinds. */
export type PickerKind = 'model' | 'provider';
