import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../src/shared/keybindings/index";
import {
  matchesKeyState,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";

/** Default commands a keystroke runs with the given context keys set, per platform. */
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

const TERMINAL = { terminalFocus: true };

describe("terminal-safe tab keys on Win/Linux", () => {
  it("Ctrl+T and Ctrl+W stay with the shell in the terminal", () => {
    expect(commandsFor({ code: "KeyT", ctrl: true }, false, TERMINAL)).toEqual([]);
    expect(commandsFor({ code: "KeyW", ctrl: true }, false, TERMINAL)).toEqual([]);
  });

  it("Ctrl+Shift+T opens a terminal, from the terminal too", () => {
    for (const context of [{}, TERMINAL, { editorFocus: true }]) {
      expect(commandsFor({ code: "KeyT", ctrl: true, shift: true }, false, context)).toEqual([
        COMMANDS.terminalNew,
      ]);
    }
  });

  it("Ctrl+F4 closes the tab, from the terminal too", () => {
    for (const context of [{}, TERMINAL, { editorFocus: true }]) {
      expect(commandsFor({ code: "F4", ctrl: true }, false, context)).toEqual([COMMANDS.tabClose]);
    }
  });

  it("Ctrl+T and Ctrl+W keep working outside the terminal", () => {
    expect(commandsFor({ code: "KeyT", ctrl: true }, false)).toEqual([COMMANDS.terminalNew]);
    expect(commandsFor({ code: "KeyW", ctrl: true }, false)).toEqual([COMMANDS.tabClose]);
  });
});

describe("terminal-safe tab keys on macOS", () => {
  it("adds nothing: ⌃⇧T and ⌃F4 stay unbound", () => {
    expect(commandsFor({ code: "KeyT", ctrl: true, shift: true }, true, TERMINAL)).toEqual([]);
    expect(commandsFor({ code: "F4", ctrl: true }, true, TERMINAL)).toEqual([]);
  });

  it("⌘T and ⌘W work in the terminal as before", () => {
    expect(commandsFor({ code: "KeyT", meta: true }, true, TERMINAL)).toEqual([
      COMMANDS.terminalNew,
    ]);
    expect(commandsFor({ code: "KeyW", meta: true }, true, TERMINAL)).toEqual([COMMANDS.tabClose]);
  });
});
