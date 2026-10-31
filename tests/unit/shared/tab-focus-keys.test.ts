import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import { findDisplayPrimary, KEYBINDINGS } from "../../../src/shared/keybindings/index";
import {
  eventToAccelerator,
  matchesKeyState,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";

/** Default commands a keystroke runs outside any focus scope, per platform. */
function commandsFor(
  state: { code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean },
  isMac: boolean,
): string[] {
  const s = { meta: false, ctrl: false, shift: false, alt: false, ...state };
  return KEYBINDINGS.filter((b) => {
    if (b.primary === undefined) return false;
    if (b.when !== undefined && !evaluateWhen(parseWhen(b.when), (k) => k === "isMac" && isMac)) {
      return false;
    }
    return matchesKeyState(parseAccelerator(b.primary), s, isMac);
  }).map((b) => b.command);
}

describe("tab focus keys", () => {
  it("Ctrl+PageUp/PageDown cycle tabs on Win/Linux", () => {
    expect(commandsFor({ code: "PageUp", ctrl: true }, false)).toEqual([COMMANDS.tabFocusPrev]);
    expect(commandsFor({ code: "PageDown", ctrl: true }, false)).toEqual([COMMANDS.tabFocusNext]);
  });

  it("leaves ⌃PageUp/PageDown alone on macOS", () => {
    expect(commandsFor({ code: "PageUp", ctrl: true }, true)).toEqual([]);
    expect(commandsFor({ code: "PageDown", ctrl: true }, true)).toEqual([]);
  });

  it("keeps ⌘⌃←/→ on macOS", () => {
    expect(commandsFor({ code: "ArrowLeft", meta: true, ctrl: true }, true)).toEqual([
      COMMANDS.tabFocusPrev,
    ]);
    expect(commandsFor({ code: "ArrowRight", meta: true, ctrl: true }, true)).toEqual([
      COMMANDS.tabFocusNext,
    ]);
  });
});

describe("findDisplayPrimary", () => {
  it("shows Ctrl+PageUp, not Win+Ctrl+←, on Win/Linux", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabFocusPrev, false)?.primary).toBe(
      "Ctrl+PageUp",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabFocusNext, false)?.primary).toBe(
      "Ctrl+PageDown",
    );
  });

  it("shows ⌘⌃←/→ on macOS", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabFocusPrev, true)?.primary).toBe(
      "Cmd+Ctrl+Left",
    );
  });

  it("keeps a Cmd+Ctrl binding when the command has no other primary", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.workspaceFocusPrev, false)?.primary).toBe(
      "Cmd+Ctrl+Up",
    );
  });

  it("shows the key that also works from the terminal on Win/Linux", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.terminalNew, false)?.primary).toBe(
      "Ctrl+Shift+T",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabClose, false)?.primary).toBe("Ctrl+F4");
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.filesRefresh, false)?.primary).toBe(
      "CmdOrCtrl+Shift+R",
    );
  });

  it("keeps ⌘T and ⌘W on macOS", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.terminalNew, true)?.primary).toBe(
      "CmdOrCtrl+T",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabClose, true)?.primary).toBe("CmdOrCtrl+W");
  });

  it("returns the first primary otherwise", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.fileOpen, false)?.primary).toBe("CmdOrCtrl+E");
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabCloseAll, false)).toBeUndefined();
  });
});

describe("PageUp / PageDown tokens", () => {
  it("parse to their physical keys", () => {
    expect(parseAccelerator("Ctrl+PageUp").codes).toEqual(["PageUp"]);
    expect(parseAccelerator("Ctrl+PageDown").codes).toEqual(["PageDown"]);
  });

  it("record from a keystroke", () => {
    const e = (code: string, mods: Partial<KeyboardEvent>) =>
      ({
        code,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...mods,
      }) as KeyboardEvent;
    expect(eventToAccelerator(e("PageDown", { ctrlKey: true }), false)).toBe("CmdOrCtrl+PageDown");
    expect(eventToAccelerator(e("PageUp", { ctrlKey: true }), true)).toBe("Ctrl+PageUp");
  });
});
