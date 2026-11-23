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
import { isLinux, isMac } from "../../infra/platform";

const logger = createLogger("browser-keyboard");

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(ALL_COMMAND_IDS);

const BROWSER_COMMANDS: readonly CommandId[] = [
  COMMANDS.browserFocusUrl,
  COMMANDS.browserReload,
  COMMANDS.browserHardReload,
  COMMANDS.browserGoBack,
  COMMANDS.browserGoForward,
];
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
  COMMANDS.sessionNextWaiting,
  COMMANDS.settingsOpen,
  COMMANDS.workbenchToggleSidebar,
  COMMANDS.workbenchToggleAgentView,
];
const PAGE_COMMAND_SET: ReadonlySet<string> = new Set([...BROWSER_COMMANDS, ...APP_COMMANDS]);

const PAGE_CONTEXT: Readonly<Record<string, boolean>> = {
  browserTabActive: true,
  isMac: isMac(),
  isLinux: isLinux(),
};

interface CompiledBinding {
  command: CommandId;
  parsed: ParsedKeystroke;
}

let compiled: CompiledBinding[] = compile(undefined);

function compile(overrides: readonly KeybindingOverride[] | undefined): CompiledBinding[] {
  const effective = applyKeybindingOverrides(KEYBINDINGS, overrides, KNOWN_COMMANDS);
  const out: CompiledBinding[] = [];
  for (const decl of effective) {
    if (!PAGE_COMMAND_SET.has(decl.command)) continue;
    if (decl.primary === undefined) continue;
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

export function updateBrowserKeybindings(
  overrides: readonly KeybindingOverride[] | undefined,
): void {
  compiled = compile(overrides);
}

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
      if (matchesKeyState(b.parsed, state, isMac())) {
        event.preventDefault();
        run(b.command, tabId);
        return;
      }
    }
  });
}
