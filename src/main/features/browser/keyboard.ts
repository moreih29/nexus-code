/**
 * Browser-view key interceptor (main process).
 *
 * WHY THIS EXISTS
 * A browser tab is a `WebContentsView` — a separate web contents painted
 * over the renderer DOM. Keystrokes that land while the *page* has focus
 * never reach the renderer window's document, so the global keybinding
 * dispatcher (which listens there) cannot see them. That is why the
 * browser shortcuts (⌘R reload, ⌘⇧R hard reload, ⌘[ / ⌘] back/forward,
 * ⌘L focus URL, ⌘⌥I devtools) appeared dead once you clicked into a page.
 *
 * The fix: intercept input on each browser webContents via
 * `before-input-event` in main, match it against the SAME declarative
 * KEYBINDINGS table (with user overrides applied), and run the command.
 * Five of the six act in main directly through the registry; URL focus is
 * a renderer concern, so it is bounced back over IPC.
 *
 * App shortcuts (new file / terminal, close and cycle tabs, groups,
 * workspaces, settings) were dead in a page for the same reason. The ones
 * Chrome keeps from pages (Ctrl+N/T/W, Ctrl+Shift+N/W, Ctrl+PageUp/Down)
 * and the app's tab / group / workspace keys are matched here too and run
 * in the app window. Keys a page uses (copy, paste, find, save, Ctrl+B
 * bold, Ctrl+K…) stay with the page.
 *
 * Customization: `updateBrowserKeybindings(overrides)` recomputes the
 * match list from defaults + user overrides; main calls it at boot and on
 * every `keybindingsChanged`. Matching reuses `parseAccelerator` +
 * `matchesKeyState`, so the renderer dispatcher and this interceptor can
 * never diverge on what a given accelerator means.
 *
 * Scope note: `before-input-event` only fires for the focused webContents,
 * and we only attach to browser views. So a binding's `when` is evaluated
 * once, at compile time, against a focused page: `browserTabActive` holds,
 * `isMac` is the platform's, and every focus key (editorFocus,
 * terminalFocus, …) is false.
 */

import type { WebContents } from "electron";
import { ALL_COMMAND_IDS, COMMANDS, type CommandId } from "../../../shared/keybindings/commands";
import { KEYBINDINGS } from "../../../shared/keybindings/index";
import {
  matchesKeyState,
  type ParsedKeystroke,
  parseAccelerator,
} from "../../../shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../shared/keybindings/keybinding-when";
import {
  applyKeybindingOverrides,
  type KeybindingOverride,
} from "../../../shared/keybindings/overrides";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("browser-keyboard");

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(ALL_COMMAND_IDS);
const IS_MAC = process.platform === "darwin";

/**
 * Commands this interceptor routes when the browser page view has focus.
 * (DevTools is intentionally excluded — ⌘⌥I belongs to the Electron menu
 * role for app-window DevTools; the browser page's DevTools is button-only.)
 */
const BROWSER_COMMANDS: readonly CommandId[] = [
  COMMANDS.browserFocusUrl,
  COMMANDS.browserReload,
  COMMANDS.browserHardReload,
  COMMANDS.browserGoBack,
  COMMANDS.browserGoForward,
];
/**
 * App commands this interceptor routes when the page has focus; they run in
 * the app window (see `run`). Content keys stay with the page: file open /
 * save, the files panel (Ctrl+B is bold in web editors), the ⌘K chords,
 * symbol search and the path actions.
 */
const APP_COMMANDS: readonly CommandId[] = [
  COMMANDS.fileNew,
  COMMANDS.terminalNew,
  COMMANDS.tabClose,
  COMMANDS.tabCloseOthers,
  COMMANDS.tabFocusPrev,
  COMMANDS.tabFocusNext,
  COMMANDS.groupSplitRight,
  COMMANDS.groupSplitDown,
  COMMANDS.groupClose,
  COMMANDS.groupFocusLeft,
  COMMANDS.groupFocusRight,
  COMMANDS.groupFocusUp,
  COMMANDS.groupFocusDown,
  COMMANDS.workspaceFocusPrev,
  COMMANDS.workspaceFocusNext,
  COMMANDS.workspaceAdd,
  COMMANDS.settingsOpen,
  COMMANDS.workbenchToggleSidebar,
];
const PAGE_COMMAND_SET: ReadonlySet<string> = new Set([...BROWSER_COMMANDS, ...APP_COMMANDS]);

/** Context keys while a page has focus; any key not listed is false. */
const PAGE_CONTEXT: Readonly<Record<string, boolean>> = {
  browserTabActive: true,
  isMac: IS_MAC,
};

interface CompiledBinding {
  command: CommandId;
  parsed: ParsedKeystroke;
}

/** Current effective (defaults + overrides) primary bindings for page commands. */
let compiled: CompiledBinding[] = compile(undefined);

function compile(overrides: readonly KeybindingOverride[] | undefined): CompiledBinding[] {
  const effective = applyKeybindingOverrides(KEYBINDINGS, overrides, KNOWN_COMMANDS);
  const out: CompiledBinding[] = [];
  for (const decl of effective) {
    if (!PAGE_COMMAND_SET.has(decl.command)) continue;
    if (decl.primary === undefined) continue; // unbound or chord-only — nothing to match
    try {
      if (decl.when !== undefined) {
        const holds = evaluateWhen(parseWhen(decl.when), (key) => PAGE_CONTEXT[key] ?? false);
        if (!holds) continue;
      }
      out.push({ command: decl.command as CommandId, parsed: parseAccelerator(decl.primary) });
    } catch (err) {
      logger.warn(`skipping unparseable browser binding ${decl.command}=${decl.primary}: ${err}`);
    }
  }
  return out;
}

/** Recompute the browser match list from user overrides (boot + on change). */
export function updateBrowserKeybindings(
  overrides: readonly KeybindingOverride[] | undefined,
): void {
  compiled = compile(overrides);
}

/**
 * Attach the `before-input-event` interceptor to one browser webContents.
 * `run` executes the resolved command for `tabId` (registry action or an
 * IPC bounce). Safe to call once per view at creation time.
 */
export function installBrowserKeyInterceptor(
  wc: WebContents,
  tabId: string,
  run: (command: CommandId, tabId: string) => void,
): void {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (typeof input.code !== "string" || input.code === "") return;

    const state = {
      code: input.code,
      meta: input.meta,
      ctrl: input.control,
      shift: input.shift,
      alt: input.alt,
    };

    for (const b of compiled) {
      if (matchesKeyState(b.parsed, state, IS_MAC)) {
        event.preventDefault();
        run(b.command, tabId);
        return;
      }
    }
  });
}
