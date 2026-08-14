/**
 * GRACE TUI app (full-screen interface).
 *
 * The single React root: composes the layout (header / activity-or-home /
 * palette / input / footer) and owns ALL keyboard handling. Keys route by
 * what is currently open (permission → picker → login → palette → help →
 * global shortcuts → focus-specific editing), so every interactive element
 * is genuinely wired to the store.
 */
import { createElement as h, useSyncExternalStore } from 'react';
import { Box, useApp, useCursor, useInput, useWindowSize } from 'ink';
import {
  ActivityPanel,
  Footer,
  HelpOverlay,
  HomeScreen,
  InputLine,
  LoginOverlay,
  PaletteOverlay,
  PermissionDialog,
  PickerOverlay,
  StatusHeader,
} from './components.ts';
import { SLASH_COMMANDS } from './commands.ts';
import type { TuiRunner } from './runner.ts';
import type { TuiStore } from './store.ts';

export interface AppProps {
  store: TuiStore;
  runner: TuiRunner;
  onExit: () => void;
}

export function GraceApp({ store, runner, onExit }: AppProps): ReturnType<typeof h> {
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const size = useWindowSize();
  const rows = size.rows ?? 24;
  const app = useApp();

  // Hide the terminal cursor — the input line draws its own block cursor.
  useCursor();

  const visibleLines = Math.max(1, rows - 8);

  useInput((input, key) => {
    void version;
    // ---------------------------------------------------------------------
    // 1. Overlays take priority
    // ---------------------------------------------------------------------
    if (store.permission) {
      if (key.escape || input === 'n' || input === 'N') {
        store.answerPermission(false);
      } else if (input === 'y' || input === 'Y') {
        store.answerPermission(true);
      } else if (input === 'a' || input === 'A') {
        runner.rememberPrefix(store.permission.command);
        store.answerPermission(true);
      }
      return;
    }

    if (store.picker) {
      if (key.escape) {
        store.closePicker();
      } else if (key.return) {
        store.pickerSelect();
      } else if (key.upArrow || input === 'k') {
        store.pickerMove(-1);
      } else if (key.downArrow || input === 'j') {
        store.pickerMove(1);
      } else if (key.backspace) {
        store.pickerFilter(store.picker.filter.slice(0, -1));
      } else if (key.delete) {
        store.pickerFilter(store.picker.filter.slice(0, -1));
      } else if (input && !key.ctrl) {
        store.pickerFilter(store.picker.filter + input);
      }
      return;
    }

    if (store.login) {
      if (key.escape) {
        store.closeLogin();
      } else if (key.return) {
        void runner.submitAuth();
      } else if (key.tab) {
        store.loginNextField();
      } else if (key.upArrow) {
        store.loginSetField('email');
      } else if (key.downArrow) {
        store.loginSetField(store.login.purpose === 'register' ? 'confirm' : 'password');
      } else if (key.backspace) {
        store.loginBackspace();
      } else if (key.leftArrow || key.rightArrow) {
        // no-op: fields are simple lines
      } else if (input && !key.ctrl) {
        store.loginType(input);
      }
      return;
    }

    if (store.palette) {
      store.setPaletteCommands(SLASH_COMMANDS);
      if (key.escape) {
        store.clearInput(); // Esc cancels the palette and the partial query
      } else if (key.return) {
        const selected = store.paletteRows()[store.palette.selected];
        const text = selected && store.input !== selected.name && !store.input.startsWith(selected.name + ' ')
          ? selected.name
          : store.input;
        submit(text);
      } else if (key.upArrow || input === 'k') {
        store.paletteMove(-1);
      } else if (key.downArrow || input === 'j') {
        store.paletteMove(1);
      } else if (key.backspace) {
        store.backspace();
      } else if (input && !key.ctrl) {
        store.insert(input);
      }
      return;
    }

    if (store.helpOpen) {
      if (key.escape || key.return || input === 'q' || input === 'Q') {
        store.closeHelp();
      }
      return;
    }

    // ---------------------------------------------------------------------
    // 2. Global shortcuts
    // ---------------------------------------------------------------------
    if (input === 'c' && key.ctrl) {
      if (runner.isBusy()) runner.cancelTask();
      else onExit();
      return;
    }
    if (input === 'd' && key.ctrl && !runner.isBusy()) {
      // Ctrl+D (EOF) exits when idle, matching the classic prompt.
      onExit();
      return;
    }
    if (input === 'l' && key.ctrl) {
      store.clearActivity();
      return;
    }
    if (input === 'r' && key.ctrl) {
      store.refresh();
      return;
    }
    if (key.tab) {
      store.toggleFocus();
      return;
    }
    if (key.pageUp) {
      store.scrollUp(visibleLines);
      return;
    }
    if (key.pageDown) {
      store.scrollDown(visibleLines);
      return;
    }
    if (key.escape) {
      if (store.input) store.clearInput();
      return;
    }

    // ---------------------------------------------------------------------
    // 3. Focus-specific
    // ---------------------------------------------------------------------
    if (store.focus === 'activity') {
      if (key.upArrow) store.scrollUp(1);
      else if (key.downArrow) store.scrollDown(1);
      else if (key.home) store.scrollUp(10_000);
      else if (key.end) store.scrollToBottom();
      else if (key.return) store.toggleFocus();
      return;
    }

    // ---------------------------------------------------------------------
    // 4. Input editing (real text editing)
    // ---------------------------------------------------------------------
    if (key.return) {
      submit(store.input);
      return;
    }
    if (key.upArrow) {
      store.historyUp();
      return;
    }
    if (key.downArrow) {
      store.historyDown();
      return;
    }
    if (key.leftArrow) {
      store.moveLeft();
      return;
    }
    if (key.rightArrow) {
      store.moveRight();
      return;
    }
    if (key.home || (input === 'a' && key.ctrl)) {
      store.home();
      return;
    }
    if (key.end || (input === 'e' && key.ctrl)) {
      store.end();
      return;
    }
    if (key.backspace) {
      store.backspace();
      return;
    }
    if (key.delete) {
      store.delete();
      return;
    }
    if (input && !key.ctrl) {
      store.insert(input);
    }
  });

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || runner.isBusy()) return;
    store.submitInput();
    if (trimmed.startsWith('/')) {
      void runner.runSlash(trimmed);
    } else {
      void runner.runTask(trimmed);
    }
  };

  const hasActivity = store.items.length > 0;
  const showHome = store.mode === 'home' && !hasActivity && !store.busy;

  let middle: ReturnType<typeof h>;
  if (store.permission) middle = h(PermissionDialog, { store });
  else if (store.picker) middle = h(PickerOverlay, { store });
  else if (store.login) middle = h(LoginOverlay, { store });
  else if (store.helpOpen) middle = h(HelpOverlay, { store });
  else if (showHome) middle = h(HomeScreen, { store });
  else middle = h(ActivityPanel, { store });

  const palette = store.palette ? h(PaletteOverlay, { store }) : null;

  return h(
    Box,
    { flexDirection: 'column', height: rows },
    h(StatusHeader, { store }),
    h(Box, { flexGrow: 1, flexDirection: 'column', justifyContent: showHome ? 'center' : 'flex-start' }, middle),
    palette,
    h(InputLine, { store }),
    h(Footer, { store }),
  );
}
