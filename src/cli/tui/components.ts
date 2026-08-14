/**
 * TUI components (GRACE full-screen interface).
 *
 * Pure presentation: every component reads the store and renders. No JSX —
 * the project runs TypeScript through Node's native type stripping, so the
 * tree is built with createElement (`h`). Colors come from Ink Text props;
 * all text is ANSI-free.
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { symbols } from '../ui/theme.ts';
import { logoLines, wordmark } from './logo.ts';
import { SLASH_COMMANDS } from './commands.ts';
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
// Header + footer
// ---------------------------------------------------------------------------

export function StatusHeader({ store }: { store: TuiStore }): ReactNode {
  const info = store.info;
  const size = useWindowSize();
  const narrow = (size.columns ?? 80) < 60;

  const statusParts: string[] = [];
  if (info.providerAvailable) {
    statusParts.push(`${info.provider}`);
    if (!narrow) statusParts.push(`${info.model}`);
  }
  const busyDot = store.busy
    ? h(Text, { color: 'cyan', bold: true }, ' ● working')
    : null;

  return h(
    Box,
    { borderStyle: 'single', borderColor: 'gray', paddingX: 1, flexDirection: 'row' },
    h(Box, { width: narrow ? 8 : 12 }, h(Text, { bold: true, color: 'cyan' }, wordmark())),
    h(Text, { color: 'gray' }, ' '),
    h(
      Box,
      { flexGrow: 1, flexDirection: 'row' },
      h(Text, { color: 'gray', dimColor: true }, info.workspace),
    ),
    busyDot,
    h(Text, { color: 'gray' }, ' · '),
    h(Text, { color: statusTextColor(info) }, statusParts.join(' · ') || (info.providerAvailable ? '' : 'no provider')),
    h(Text, { color: 'gray' }, ' · '),
    h(Text, { color: 'green' }, info.session),
  );
}

function statusTextColor(info: { providerAvailable: boolean }): string {
  return info.providerAvailable ? 'cyan' : 'yellow';
}

export function Footer({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  if ((size.rows ?? 24) < 14) return null;
  const focusHint = store.focus === 'input' ? 'Tab: scroll output' : 'Tab: type';
  return h(
    Box,
    { borderStyle: 'single', borderColor: 'gray', paddingX: 1, flexDirection: 'row' },
    h(
      Box,
      { flexGrow: 1, flexDirection: 'row' },
      h(Text, { dimColor: true }, ' / = commands  ·  ↑↓ history  ·  Ctrl+L clear  ·  Ctrl+C cancel/exit  ·  '),
      h(Text, { dimColor: true }, focusHint),
    ),
    h(Text, { dimColor: true }, ` v${store.info.version}`),
  );
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

export function HomeScreen({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  const info = store.info;
  const columns = size.columns ?? 80;
  const logo = logoBlock(columns);

  const rows: ReactNode[] = [
    h(
      Box,
      { flexDirection: 'column', alignItems: 'center' },
      ...logo.map((line, i) => h(Text, { key: i, bold: true, color: 'cyan' }, line)),
      h(Text, { color: 'gray' }, 'AI Coding Agent'),
      h(Text, { color: 'gray', dimColor: true }, ''),
    ),
  ];

  rows.push(
    h(
      Box,
      { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
      h(Text, {}, ' '),
      h(Text, { color: 'gray' }, 'Workspace'),
      h(Text, { bold: true }, info.workspace),
      h(Text, {}, ' '),
      h(Text, { color: 'gray' }, 'Model'),
      h(
        Text,
        { color: info.providerAvailable ? 'cyan' : 'yellow' },
        info.providerAvailable ? `${info.provider} · ${info.model}` : info.providerError ?? 'not configured',
      ),
      h(Text, {}, ' '),
      h(Text, { color: 'gray' }, 'Session'),
      h(Text, { color: 'green' }, info.session),
      info.freePlan ? h(Text, { color: 'gray' }, info.freePlan) : null,
    ),
  );

  rows.push(
    h(
      Box,
      { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
      h(Text, { color: 'gray', dimColor: true }, 'Type a coding task, or / for commands'),
      h(Text, { color: 'gray', dimColor: true }, 'Ctrl+C exits · /help for everything else'),
    ),
  );

  return h(
    Box,
    { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
    ...rows,
  );
}

/** Center the logo lines for the current width. */
function logoBlock(columns: number): string[] {
  const lines = logoLines();
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => {
    const pad = Math.max(0, Math.floor((columns - width) / 2));
    return ' '.repeat(pad) + l;
  });
}

// ---------------------------------------------------------------------------
// Activity panel
// ---------------------------------------------------------------------------

export function ActivityPanel({ store, height }: { store: TuiStore; height?: number }): ReactNode {
  // The panel sizes itself from the terminal unless the caller pins a height
  // (tests render with an explicit height). Chrome = header + input + footer.
  const size = useWindowSize();
  const termRows = size.rows ?? 24;
  const chrome = 3 + 3 + (termRows >= 14 ? 3 : 2);
  const paletteH = store.palette ? 13 : 0;
  const panelHeight = height ?? Math.max(4, termRows - chrome - paletteH);
  const inner = Math.max(1, panelHeight - 2); // borders
  const items = store.items;
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

  return h(
    Box,
    { borderStyle: 'round', borderColor: 'gray', flexGrow: 1, flexDirection: 'column', paddingX: 1, height: panelHeight },
    ...rows,
  );
}

function renderItem(item: ActivityItem): ReactNode {
  const style = colorForKind(item.kind);
  return h(
    Text,
    { key: item.id, ...style },
    item.text,
  );
}

// ---------------------------------------------------------------------------
// Input line
// ---------------------------------------------------------------------------

export function InputLine({ store }: { store: TuiStore }): ReactNode {
  const size = useWindowSize();
  const columns = size.columns ?? 80;
  const inner = Math.max(8, columns - 4); // border + padding
  const prefix = 'grace> ';
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
      ? h(Text, { color: 'gray', dimColor: true }, 'Ask me to fix a bug, add a feature, or type / for commands')
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
    h(Text, { bold: true, color: 'cyan' }, 'grace'),
    h(Text, { color: 'cyan' }, '> '),
    h(Box, { flexGrow: 1 }, content),
    store.busy ? h(Text, { color: 'cyan', dimColor: true }, ' ⏳') : null,
  );
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
