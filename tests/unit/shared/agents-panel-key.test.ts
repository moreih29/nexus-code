/**
 * `]` shows the files panel on its agent list. A bare key, so it is the
 * app's only where it types nothing: not in a text field, an editor or the
 * terminal, and never with a modifier held.
 */
import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../src/shared/keybindings/index";
import {
  matchesKeyState,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";

/** Default commands a keystroke runs with the given context keys set. */
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

describe("the agents panel key", () => {
  it("is ] where nothing has the keyboard, on every platform", () => {
    for (const isMac of [true, false]) {
      expect(commandsFor(BRACKET, isMac)).toEqual([COMMANDS.workbenchToggleAgentsPanel]);
    }
  });

  it("types ] in a text field, an editor and the terminal", () => {
    for (const isMac of [true, false]) {
      for (const focus of ["inputFocus", "editorFocus", "terminalFocus"]) {
        expect(commandsFor(BRACKET, isMac, { [focus]: true })).toEqual([]);
      }
    }
  });

  it("leaves } and the modified keys alone", () => {
    expect(commandsFor({ ...BRACKET, shift: true }, true)).toEqual([]);
    expect(commandsFor({ ...BRACKET, alt: true }, true)).toEqual([]);
    expect(commandsFor({ ...BRACKET, ctrl: true }, true)).toEqual([]);
    // ⌘] is the browser tab's forward, not this.
    expect(commandsFor({ ...BRACKET, meta: true }, true)).not.toContain(
      COMMANDS.workbenchToggleAgentsPanel,
    );
    expect(commandsFor({ ...BRACKET, ctrl: true }, false)).not.toContain(
      COMMANDS.workbenchToggleAgentsPanel,
    );
  });
});
