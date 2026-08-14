/**
 * GRACE TUI app (full-screen interface).
 *
 * The single React root: composes the layout (home hero OR session feed +
 * input) and owns ALL keyboard handling. Keys route by what is currently
 * open (permission → picker → login → palette → help → global shortcuts →
 * focus-specific editing), so every interactive element is genuinely wired
 * to the store.
 *
 * Layout: the home screen is the full hero (logo → input → shortcuts →
 * status). After the first task the app switches to the session layout
 * (slim task header → activity feed → input). No permanent top/bottom bars.
 */
import { createElement as h, useSyncExternalStore } from 'react';
import { Box, useCursor, useInput, useWindowSize } from 'ink';
import {
  ActivityPanel,
  HelpOverlay,
  HomeScreen,
  InputLine,
  LoginOverlay,
  PaletteOverlay,
  PermissionDialog,
  PickerOverlay,
  TaskHeader,
} from './components.ts';
import { HOME_SHORTCUTS, SLASH_COMMANDS } from './commands.ts';
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
      if (store.focus === 'shortcuts') store.setFocus('input');
      else if (store.input) store.clearInput();
      return;
    }

    // ---------------------------------------------------------------------
    // 2b. Home shortcut row (focused via Tab)
    // ---------------------------------------------------------------------
    if (store.focus === 'shortcuts') {
      if (key.leftArrow) {
        store.shortcutMove(-1);
      } else if (key.rightArrow) {
        store.shortcutMove(1);
      } else if (key.return) {
        const shortcut = HOME_SHORTCUTS[store.shortcutIndex];
        if (shortcut) submit(shortcut.name);
      } else if (input && !key.ctrl) {
        // Typing always returns to the input.
        store.setFocus('input');
        store.insert(input);
      }
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

  const paletteH = store.palette ? 13 : 0;
  const panelHeight = Math.max(4, rows - 8 - paletteH);

  let middle: ReturnType<typeof h>;
  if (store.permission) middle = h(PermissionDialog, { store });
  else if (store.picker) middle = h(PickerOverlay, { store });
  else if (store.login) middle = h(LoginOverlay, { store });
  else if (store.helpOpen) middle = h(HelpOverlay, { store });
  else if (showHome) middle = h(HomeScreen, { store });
  else middle = h(ActivityPanel, { store, hideLatestUser: true, height: panelHeight });

  const palette = store.palette && !showHome ? h(PaletteOverlay, { store }) : null;

  if (showHome) {
    // Home is the full hero: logo → input → shortcuts → status, plus the
    // palette in place of the shortcuts while typing a slash command.
    return h(Box, { flexDirection: 'column', height: rows }, middle);
  }

  // Session: slim task header, live feed, input. No permanent bars.
  return h(
    Box,
    { flexDirection: 'column', height: rows },
    h(TaskHeader, { store }),
    middle,
    palette,
    h(InputLine, { store }),
  );
}
