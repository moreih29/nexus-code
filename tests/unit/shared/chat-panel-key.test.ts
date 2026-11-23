import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../src/shared/keybindings/index";
import {
  matchesKeyState,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";

function commandsFor(
  state: { code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean },
  isMac: boolean,
  context: Record<string, boolean> = {},
): string[] {
  const s = { meta: false, ctrl: false, shift: false, alt: false, ...state };
  const keys: Record<string, boolean> = { ...context, isMac };
  return KEYBINDINGS.filter((b) => {
    if (b.primary === undefined) return false;
    if (b.when !== undefined && !evaluateWhen(parseWhen(b.when), (k) => keys[k] ?? false)) {
      return false;
    }
    return matchesKeyState(parseAccelerator(b.primary), s, isMac);
  }).map((b) => b.command);
}

const BRACKET = { code: "BracketRight" };
const MAC_KEY = { ...BRACKET, meta: true, shift: true };
const OTHER_KEY = { ...BRACKET, ctrl: true, shift: true };

describe("the chat side panel key", () => {
  it("is ⌘⇧] on the Mac and Ctrl+Shift+] elsewhere, with a chat's panel in front", () => {
    expect(commandsFor(MAC_KEY, true, { chatPanelActive: true })).toEqual([
      COMMANDS.chatTogglePanel,
    ]);
    expect(commandsFor(OTHER_KEY, false, { chatPanelActive: true })).toEqual([
      COMMANDS.chatTogglePanel,
    ]);
  });

  it("is the app's in the chat's box too", () => {
    expect(commandsFor(MAC_KEY, true, { chatPanelActive: true, inputFocus: true })).toEqual([
      COMMANDS.chatTogglePanel,
    ]);
  });

  it("is not the app's with no chat's panel in front", () => {
    expect(commandsFor(MAC_KEY, true)).toEqual([]);
    expect(commandsFor(OTHER_KEY, false, { terminalFocus: true })).toEqual([]);
  });

  it("leaves ] and ⌘] alone", () => {
    expect(commandsFor(BRACKET, true, { chatPanelActive: true })).toEqual([]);
    expect(commandsFor({ ...BRACKET, meta: true }, true, { chatPanelActive: true })).toEqual([]);
    expect(
      commandsFor({ ...BRACKET, ctrl: true, shift: true }, true, { chatPanelActive: true }),
    ).toEqual([]);
  });
});
