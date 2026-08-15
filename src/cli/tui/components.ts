/**
 * TUI components (GRACE full-screen interface).
 *
 * Pure presentation: every component reads the store and renders. No JSX —
 * the project runs TypeScript through Node's native type stripping, so the
 * tree is built with createElement (`h`). Colors come from Ink Text props;
 * all text is ANSI-free.
 *
 * Visual hierarchy (home): GRACE logo → input → command shortcuts → quiet
 * status row. Session mode swaps the hero for a slim task header and the
 * live activity feed. Everything interactive is wired to the store.
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { supportsUnicode, symbols } from '../ui/theme.ts';
import { formatCountdown, formatDailyUsage, sessionSecondsLeft } from '../freePlan.ts';
import { RemoteProvider } from '../../providers/remote.ts';
import { chooseLogoFor, wordmark } from './logo.ts';
import { HOME_SHORTCUTS, SLASH_COMMANDS } from './commands.ts';
import type { TuiStore } from './store.ts';
import type { ActivityItem, ActivityKind } from './types.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function colorForKind(kind: ActivityKind): { color?: string; bold?: boolean; dim?: boolean } {
  switch (kind) {
    case 'user':
      return { color: 'cyan', bold: true };
    case 'system':
      return { color: 'gray' };
    case 'progress':
      return { color: 'gray' };
    case 'tool':
      return { color: 'cyan' };
    case 'file':
      return { color: 'green' };
    case 'success':
      return { color: 'green' };
    case 'error':
      return { color: 'red' };
    case 'info':
      return { color: 'yellow' };
    case 'result':
      return {};
    case 'console':
      return { color: 'gray' };
    default:
      return {};
  }
}

/** Truncate long values with an ellipsis so nothing overflows its column. */
function fit(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Animated spinner (subtle, only while the agent works). */
export function Spinner({ label }: { label: string }): ReactNode {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  const frames = symbols().spinner;
  return h(Text, { color: 'cyan' }, `${frames[frame % frames.length] ?? frames[0] ?? '·'} ${label}`);
}

/**
 * Live countdown of the current GRACE FREE session's remaining time. Ticks
 * once per second; hidden when no session is active (local mode, not logged
 * in, or the backend has not reported one yet). Display only — the server
 * enforces the session limit.
 */
export function SessionTimer(): ReactNode {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const expiresAt = RemoteProvider.sharedSession()?.sessionExpiresAt;
  const left = sessionSecondsLeft(expiresAt);
  if (left === null) return null;
  const clock = supportsUnicode() ? '⏱ ' : '';
  const label = left <= 0 ? 'session expired' : `${formatCountdown(left)} left`;
  return h(Text, { color: 'yellow', dimColor: true }, `${clock}${label}`);
}

/** Centered overlay frame (dialogs, pickers, help, login). */
function Overlay({ children, title }: { children?: ReactNode; title?: string }): ReactNode {
  const top = h(Text, { bold: true, color: 'cyan' }, title ?? '');
  return h(
    Box,
    { borderStyle: 'round', borderColor: 'cyan', flexDirection: 'column', paddingX: 2, paddingY: 1, width: 62 },
    title ? h(Box, { marginBottom: 1 }, top) : null,
    children,
  );
}

// ---------------------------------------------------------------------------
// Session header (coding mode)
// ---------------------------------------------------------------------------

/** Slim header above the feed: wordmark, current model, current task. */
export function TaskHeader({ store }: { store: TuiStore }): ReactNode {
  const info = store.info;
  const sym = symbols();
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const lastUser = lastUserItem(store);
  const model = info.providerAvailable ? (info.model || info.provider || '') : (info.providerError ?? '');
  const sessionState = RemoteProvider.sharedSession();
  const sessionNum =
    sessionState && typeof sessionState.currentSession === 'number'
      ? `Session ${sessionState.currentSession}/${sessionState.sessionsUsed + sessionState.sessionsRemaining} · `
      : null;

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { bold: true, color: 'cyan', dimColor: true }, wordmark()),
      h(Box, { flexGrow: 1 }),
      columns >= 60
        ? h(
            Box,
            { flexDirection: 'row' },
            sessionNum ? h(Text, { color: 'yellow', dimColor: true }, sessionNum) : null,
            h(SessionTimer, {}),
          )
        : null,
      model ? h(Text, { color: 'gray', dimColor: true }, fit(model, 44)) : null,
    ),
    lastUser
      ? h(
          Box,
          { flexDirection: 'row', marginTop: 1 },
          h(Text, { bold: true, color: 'cyan' }, '› '),
          h(Text, { bold: true }, fit(lastUser.text, Math.max(16, columns - 4))),
        )
      : null,
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: 'gray', dimColor: true }, sym.hLine.repeat(Math.max(12, Math.min(columns - 4, 100)))),
    ),
  );
}

function lastUserItem(store: TuiStore): ActivityItem | undefined {
  for (let i = store.items.length - 1; i >= 0; i -= 1) {
    const item = store.items[i];
    if (item && item.kind === 'user') return item;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

/** Muted subtitle under the logo. */
const SUBTITLE = 'A I   C O D I N G   A G E N T';

/**
 * The startup screen: GRACE is the hero, the input is second, shortcuts are
 * secondary, and one quiet status row sits at the bottom. Everything adapts
 * to the terminal — the logo shrinks, shortcuts/status hide on short or
 * narrow screens, and nothing ever overlaps.
 */
export function HomeScreen({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const rows = size.rows ?? 24;

  // The logo rows have different real widths, so they must be left-aligned
  // inside a box sized by the logo's real width — centering each row on its
  // own would shift the letters apart (see logo.ts). The outer box then
  // centers the whole block once, as a single unit.
  const { lines: logo, width: logoWidth } = chooseLogoFor(columns, rows);
  // Vertical budget: 6-row logo + subtitle + input + shortcuts + status
  // (+ the free-plan quota line when present) ≈ 23.
  const showShortcuts = rows >= 16 && columns >= 44;
  const showStatus = rows >= 23;
  const inputWidth = Math.max(24, Math.min(columns - 4, 78));

  return h(
    Box,
    { flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
    h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        { flexDirection: 'column', width: logoWidth },
        ...logo.map((line, i) => h(Text, { key: i, bold: true, color: 'cyan' }, line)),
      ),
      h(Box, { marginTop: 1 }, h(Text, { color: 'gray', dimColor: true }, SUBTITLE)),
    ),
    h(Box, { width: inputWidth, marginTop: 2 }, h(InputLine, { store, width: inputWidth })),
    store.palette
      ? h(Box, { marginTop: 2 }, h(PaletteOverlay, { store }))
      : h(
          Box,
          { flexDirection: 'column', alignItems: 'center', marginTop: 2 },
          showShortcuts ? h(ShortcutsRow, { store }) : null,
          showStatus
            ? h(
                Box,
                { flexDirection: 'column', alignItems: 'center', marginTop: 2 },
                h(
                  Box,
                  { marginBottom: 1 },
                  h(Text, { color: 'gray', dimColor: true }, symbols().hLine.repeat(Math.max(12, Math.min(columns - 8, 56)))),
                ),
                h(StatusRow, { store }),
              )
            : null,
        ),
  );
}

// ---------------------------------------------------------------------------
// Command shortcuts (home, secondary UI)
// ---------------------------------------------------------------------------

const SHORTCUT_ICONS: Record<string, string> = {
  '/help': '▸',
  '/status': '◇',
  '/model': '◈',
  '/provider': '⚙',
};

const SHORTCUT_ICONS_ASCII: Record<string, string> = {
  '/help': '?',
  '/status': '=',
  '/model': '*',
  '/provider': '#',
};

function iconFor(name: string): string {
  const table = supportsUnicode() ? SHORTCUT_ICONS : SHORTCUT_ICONS_ASCII;
  return table[name] ?? '·';
}

/**
 * The real commands surfaced under the input. Focusable: Tab focuses the
 * row, ←/→ selects, Enter runs the command (see app.ts key routing).
 */
export function ShortcutsRow({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const withDescriptions = columns >= 112;
  const withIcons = columns >= 60;
  const selected = store.focus === 'shortcuts' ? store.shortcutIndex : -1;

  return h(
    Box,
    { flexDirection: 'row', justifyContent: 'center' },
    ...HOME_SHORTCUTS.map((c, i) => {
      const active = i === selected;
      const icon = withIcons ? `${iconFor(c.name)} ` : '';
      const desc = withDescriptions ? `  ${c.description}` : '';
      return h(
        Box,
        { key: c.name, flexDirection: 'row', marginLeft: i === 0 ? 0 : 3 },
        h(
          Text,
          { color: active ? 'cyan' : 'gray', bold: active, dimColor: !active },
          `${active ? '› ' : '  '}${icon}${c.name}${desc}`,
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Status row (home, quiet)
// ---------------------------------------------------------------------------

/**
 * One subdued status row with real values only: workspace, model, session
 * and status. Collapses to a single quiet line on narrow terminals.
 */
export function StatusRow({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const info = store.info;
  const busy = store.busy;
  const sym = symbols();

  const model = info.providerAvailable ? (info.model || info.provider || '—') : (info.providerError ?? 'no provider');
  const status = busy ? 'working' : 'ready';
  const statusColor = busy ? 'cyan' : 'green';
  const sessionState = RemoteProvider.sharedSession();
  const hasLiveSession =
    sessionState && sessionSecondsLeft(sessionState.sessionExpiresAt) !== null;

  if (columns < 70) {
    // Single quiet line. Shrink the model first; drop it when there is no
    // room, so the row never wraps on a narrow terminal. When a free session
    // is active the LIVE countdown rides along (ticks every second).
    const sep = ' · ';
    const statusText = `${sym.dot} ${status}`;
    const budget = Math.max(12, columns - 4);
    const full = `${info.workspace}${sep}${model}${sep}${info.session}${sep}${statusText}`;
    let shownModel = model;
    if (full.length > budget) {
      const room = budget - (full.length - model.length) - sep.length;
      if (room >= 8) shownModel = fit(model, room);
      else shownModel = ''; // drop the secondary value entirely
    }
    return h(
      Box,
      { flexDirection: 'row' },
      h(
        Text,
        { color: 'gray', dimColor: true },
        [info.workspace, shownModel, info.session].filter(Boolean).join(sep) + `${sep}`,
      ),
      h(Text, { color: statusColor }, statusText),
      hasLiveSession
        ? h(
            Box,
            { flexDirection: 'row' },
            h(Text, { color: 'yellow', dimColor: true }, ' · '),
            h(
              Text,
              { color: 'yellow', dimColor: true },
              `Session ${sessionState?.currentSession ?? sessionState?.sessionsUsed}/${sessionState?.sessionsUsed + (sessionState?.sessionsRemaining ?? 0)} · `,
            ),
            h(SessionTimer, {}),
          )
        : null,
    );
  }

  const cols: Array<{ label: string; value: string; color: 'gray' | 'cyan' | 'green' }> = [
    { label: 'Workspace', value: info.workspace, color: 'gray' },
    { label: 'Model', value: model, color: 'gray' },
    { label: 'Session', value: info.session, color: 'gray' },
    { label: 'Status', value: `${sym.dot} ${status}`, color: statusColor },
  ];
  const W = Math.max(12, Math.floor(Math.min(columns - 8, 96) / 4));

  // GRACE FREE quota from the backend (real, best-effort). When a session is
  // active the countdown is LIVE (ticks every second); the static line covers
  // the "N sessions remaining" / "all used" cases instead. Quiet, and only on
  // wide screens — narrow/short terminals collapse it (see /status).
  const quota =
    hasLiveSession
      ? h(
          Box,
          { flexDirection: 'row', marginTop: 1 },
          h(
            Text,
            { color: 'gray', dimColor: true },
            `Quota · Session ${sessionState.currentSession ?? sessionState.sessionsUsed}/${sessionState.sessionsUsed + sessionState.sessionsRemaining} · `,
          ),
          h(SessionTimer, {}),
          h(Text, { color: 'gray', dimColor: true }, ` · ${formatDailyUsage(sessionState.dailyUsedSeconds)} used today`),
        )
      : info.freePlan
        ? h(Box, { marginTop: 1 }, h(Text, { color: 'gray', dimColor: true }, fit(info.freePlan, Math.max(16, columns - 4))))
        : null;

  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center' },
    h(
      Box,
      { flexDirection: 'row' },
      ...cols.map((c) =>
        h(Box, { key: c.label, width: W }, h(Text, { color: 'gray', dimColor: true }, c.label)),
      ),
    ),
    h(
      Box,
      { flexDirection: 'row', marginTop: 1 },
      ...cols.map((c) => h(Box, { key: c.label, width: W }, h(Text, { color: c.color }, fit(c.value, W)))),
    ),
    quota,
  );
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

/**
 * The live feed. Windowed to the available height, follows the bottom by
 * default, marks each line by kind. In the app, the latest user line is
 * rendered by TaskHeader instead (`hideLatestUser`).
 */
export function ActivityPanel({ store, height, hideLatestUser }: { store: TuiStore; height?: number; hideLatestUser?: boolean }): ReactNode {
  const size = useWindowSize();
  const termRows = size.rows ?? 24;
  const chrome = 9; // task header (5) + input (3) + buffer (1)
  const paletteH = store.palette ? 13 : 0;
  const panelHeight = height ?? Math.max(4, termRows - chrome - paletteH);
  const inner = Math.max(1, panelHeight - 2);
  const items = hideLatestUser ? withoutLatestUser(store.items) : store.items;
  const total = items.length;
  const scroll = Math.min(store.scroll, Math.max(0, total - 1));
  const end = Math.max(0, total - scroll);
  const start = Math.max(0, end - inner);
  const windowItems = items.slice(start, end);

  const rows: ReactNode[] = [];
  if (scroll > 0) {
    rows.push(
      h(Text, { key: 'scroll-hint', color: 'yellow', dimColor: true }, `▲ ${scroll} line(s) above — End to follow latest`),
    );
  }
  if (windowItems.length === 0 && !store.busy) {
    rows.push(h(Text, { key: 'empty', color: 'gray', dimColor: true }, 'No output yet.'));
  }
  for (const item of windowItems) {
    rows.push(renderItem(item));
  }
  if (store.busy) {
    rows.push(
      h(
        Box,
        { key: 'live' },
        h(Spinner, { label: 'Grace is working…' }),
      ),
    );
  }

  return h(Box, { flexDirection: 'column', paddingX: 1, height: panelHeight, flexGrow: 1 }, ...rows);
}

/** The latest user line is promoted to TaskHeader, so drop it from the feed. */
function withoutLatestUser(items: ActivityItem[]): ActivityItem[] {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === 'user') return items.filter((_, j) => j !== i);
  }
  return items;
}

function renderItem(item: ActivityItem): ReactNode {
  const style = colorForKind(item.kind);
  return h(Text, { key: item.id, ...style }, `${prefixFor(item)}${item.text}`);
}

/** Kind markers: user ›, progress/info •, tools indented, files +, ✓/✗ marks. */
function prefixFor(item: ActivityItem): string {
  const sym = symbols();
  switch (item.kind) {
    case 'user':
      return '› ';
    case 'progress':
    case 'info':
      return '• ';
    case 'tool':
      return '  ';
    case 'file':
      return '+ ';
    case 'success':
      return item.text.trimStart().startsWith(sym.check) ? '' : `${sym.check} `;
    case 'error':
      return item.text.trimStart().startsWith(sym.cross) ? '' : `${sym.cross} `;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Input line
// ---------------------------------------------------------------------------

/**
 * The real input: keyboard editing with a visible cursor, history, and a
 * mode-aware placeholder. Width can be pinned (home) or full-terminal
 * (session). The border highlights when the input has focus.
 */
export function InputLine({ store, width }: { store: TuiStore; width?: number }): ReactNode {
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const total = width ?? columns;
  const inner = Math.max(8, total - 4);
  const prefix = '› ';
  const visible = Math.max(1, inner - prefix.length);

  const text = store.input;
  const cursor = store.cursor;
  // Horizontal scroll: keep the cursor visible.
  let start = cursor - Math.floor(visible / 2);
  if (start < 0) start = 0;
  if (start > text.length - visible) start = Math.max(0, text.length - visible);
  const view = text.slice(start, start + visible);
  const cursorInView = Math.min(visible - 1, cursor - start);

  const before = view.slice(0, cursorInView);
  const at = view.slice(cursorInView, cursorInView + 1);
  const after = view.slice(cursorInView + 1);

  const content =
    text === '' && !store.busy
      ? h(Text, { color: 'gray', dimColor: true }, fit(placeholderFor(store), Math.max(8, visible)))
      : h(
          Box,
          { flexDirection: 'row' },
          h(Text, {}, before),
          h(Text, { inverse: true, bold: true }, at || ' '),
          h(Text, {}, after),
        );

  return h(
    Box,
    { borderStyle: 'round', borderColor: store.focus === 'input' ? 'cyan' : 'gray', flexDirection: 'row', paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, '›'),
    h(Text, { color: 'cyan' }, ' '),
    h(Box, { flexGrow: 1 }, content),
    store.busy ? h(Text, { color: 'cyan', dimColor: true }, ' ⏳') : null,
  );
}

function placeholderFor(store: TuiStore): string {
  if (store.busy) return 'Grace is working… (Ctrl+C to cancel)';
  if (store.mode === 'session') return 'What’s next?';
  return 'Ask me to build, fix, refactor…';
}

// ---------------------------------------------------------------------------
// Permission dialog
// ---------------------------------------------------------------------------

export function PermissionDialog({ store }: { store: TuiStore }): ReactNode {
  const p = store.permission;
  if (!p) return null;
  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    h(
      Overlay,
      { title: 'Permission required' },
      h(Text, { color: 'gray' }, 'Grace wants to run:'),
      h(Box, { marginY: 1 }, h(Text, { bold: true, color: 'cyan' }, `  ${p.command}`)),
      h(Box, { flexDirection: 'column', marginBottom: 1 },
        ...p.reasons.map((r, i) => h(Text, { key: i, color: 'yellow', dimColor: true }, `  flagged: ${r}`)),
      ),
      h(Text, { dimColor: true }, '[Y] Allow    [N] Deny    [A] Always allow    [Esc] Deny'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Picker (models / providers)
// ---------------------------------------------------------------------------

export function PickerOverlay({ store }: { store: TuiStore }): ReactNode {
  const p = store.picker;
  if (!p) return null;
  const rows = p.options.slice(0, 12).map((opt, i) => {
    const selected = i === p.selected;
    const marker = selected ? '›' : ' ';
    const current = opt.current ? '  (current)' : '';
    const hint = opt.hint ? `  ${opt.hint}` : '';
    return h(
      Box,
      { key: opt.value + i, flexDirection: 'row' },
      h(Text, { color: selected ? 'cyan' : 'gray', bold: selected }, `${marker} ${opt.label}${current}`),
      h(Text, { color: 'gray', dimColor: true }, hint),
    );
  });
  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    h(
      Overlay,
      { title: p.title },
      h(Text, { color: 'gray', dimColor: true }, p.filter ? `filter: ${p.filter}` : 'type to filter · ↑↓ / j k · Enter select · Esc cancel'),
      h(Box, { flexDirection: 'column', marginTop: 1 }, ...rows),
      p.options.length === 0 ? h(Text, { color: 'yellow' }, 'No matches') : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

export function PaletteOverlay({ store }: { store: TuiStore }): ReactNode {
  const rows = store.paletteRows();
  return h(
    Box,
    { borderStyle: 'round', borderColor: 'cyan', flexDirection: 'column', paddingX: 1, width: 60 },
    h(Text, { color: 'gray', dimColor: true }, 'Commands'),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      ...rows.map((c, i) => {
        const selected = i === store.palette?.selected;
        return h(
          Box,
          { key: c.name, flexDirection: 'row' },
          h(Text, { color: selected ? 'cyan' : 'gray', bold: selected }, selected ? '› ' : '  '),
          h(Text, { color: selected ? 'cyan' : 'white', bold: selected }, c.name),
          h(Text, { color: 'gray', dimColor: true }, `  ${c.description}`),
        );
      }),
    ),
    rows.length === 0 ? h(Text, { color: 'yellow' }, 'No matching commands') : null,
  );
}

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

export function HelpOverlay({ store }: { store: TuiStore }): ReactNode {
  void store;
  const commands = SLASH_COMMANDS;
  const rows = commands.map((c) =>
    h(
      Box,
      { key: c.name, flexDirection: 'row' },
      h(Text, { color: 'cyan' }, c.name.padEnd(12)),
      h(Text, { color: 'gray' }, c.description),
    ),
  );
  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    h(
      Overlay,
      { title: 'Commands' },
      ...rows,
      h(Box, { marginTop: 1 }, h(Text, { color: 'gray', dimColor: true }, 'Esc closes this · every command above works')),
    ),
  );
}

// ---------------------------------------------------------------------------
// Login / register overlay
// ---------------------------------------------------------------------------

export function LoginOverlay({ store }: { store: TuiStore }): ReactNode {
  const login = store.login;
  if (!login) return null;

  const fields: Array<{ key: 'email' | 'password' | 'confirm'; label: string; value: string; masked: boolean }> = [
    { key: 'email', label: 'Email', value: login.email, masked: false },
    { key: 'password', label: 'Password', value: login.password, masked: true },
  ];
  if (login.purpose === 'register') {
    fields.push({ key: 'confirm', label: 'Confirm', value: login.confirm, masked: true });
  }

  const rows = fields.map((f) => {
    const active = login.field === f.key;
    const display = f.masked ? '•'.repeat(f.value.length) : f.value;
    const cursorChar = active ? h(Text, { inverse: true }, ' ') : null;
    return h(
      Box,
      { key: f.key, flexDirection: 'row', marginBottom: f.key === 'confirm' ? 1 : 0 },
      h(Text, { color: active ? 'cyan' : 'gray', bold: active }, f.label.padEnd(10)),
      h(Text, { color: 'gray' }, ' '),
      h(Text, {}, display),
      cursorChar,
    );
  });

  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    h(
      Overlay,
      { title: login.purpose === 'login' ? 'Log in' : 'Create account' },
      ...rows,
      login.error ? h(Text, { color: 'red' }, login.error) : null,
      h(Box, { marginTop: 1 }, h(Text, { color: 'gray', dimColor: true }, login.busy ? 'Connecting…' : 'Tab: next field · Enter: submit · Esc: cancel')),
    ),
  );
}
