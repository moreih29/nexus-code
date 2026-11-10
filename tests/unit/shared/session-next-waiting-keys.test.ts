/**
 * The key that goes to the next session waiting on the user: ⌘⇧U and
 * Ctrl+Shift+U, but Ctrl+Shift+J on Linux, where IBus takes Ctrl+Shift+U.
 * It works from the terminal too.
 */
import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import {
  findDisplayPrimary,
  KEYBINDINGS,
  type KeybindingDecl,
} from "../../../src/shared/keybindings/index";
import {
  matchesKeyState,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";
import { applyKeybindingOverrides } from "../../../src/shared/keybindings/overrides";

type Platform = "mac" | "windows" | "linux";

/** Default commands a keystroke runs with the terminal focused, per platform. */
function commandsFor(
  state: { code: string; meta?: boolean; ctrl?: boolean; shift?: boolean },
  platform: Platform,
  bindings: readonly KeybindingDecl[] = KEYBINDINGS,
): string[] {
  const s = { meta: false, ctrl: false, shift: false, alt: false, ...state };
  const isMac = platform === "mac";
  const keys: Record<string, boolean> = {
    isMac,
    isLinux: platform === "linux",
    terminalFocus: true,
  };
  return bindings
    .filter((b) => {
      if (b.primary === undefined) return false;
      if (b.when !== undefined && !evaluateWhen(parseWhen(b.when), (k) => keys[k] ?? false)) {
        return false;
      }
      return matchesKeyState(parseAccelerator(b.primary), s, isMac);
    })
    .map((b) => b.command);
}

describe("next waiting session key", () => {
  it("is ⌘⇧U on macOS, from the terminal too", () => {
    expect(commandsFor({ code: "KeyU", meta: true, shift: true }, "mac")).toEqual([
      COMMANDS.sessionNextWaiting,
    ]);
  });

  it("is Ctrl+Shift+U on Windows", () => {
    expect(commandsFor({ code: "KeyU", ctrl: true, shift: true }, "windows")).toEqual([
      COMMANDS.sessionNextWaiting,
    ]);
    expect(commandsFor({ code: "KeyJ", ctrl: true, shift: true }, "windows")).toEqual([]);
  });

  it("is Ctrl+Shift+J on Linux, leaving Ctrl+Shift+U to IBus", () => {
    expect(commandsFor({ code: "KeyJ", ctrl: true, shift: true }, "linux")).toEqual([
      COMMANDS.sessionNextWaiting,
    ]);
    expect(commandsFor({ code: "KeyU", ctrl: true, shift: true }, "linux")).toEqual([]);
  });
});

describe("a user's key for the next waiting session", () => {
  const known = new Set(Object.values(COMMANDS));
  const rebound = applyKeybindingOverrides(
    KEYBINDINGS,
    [{ command: COMMANDS.sessionNextWaiting, primary: "CmdOrCtrl+Shift+K" }],
    known,
  );

  it("works on every platform, in place of both defaults", () => {
    expect(commandsFor({ code: "KeyK", meta: true, shift: true }, "mac", rebound)).toEqual([
      COMMANDS.sessionNextWaiting,
    ]);
    for (const platform of ["windows", "linux"] as const) {
      expect(commandsFor({ code: "KeyK", ctrl: true, shift: true }, platform, rebound)).toEqual([
        COMMANDS.sessionNextWaiting,
      ]);
    }
    expect(commandsFor({ code: "KeyU", ctrl: true, shift: true }, "windows", rebound)).toEqual([]);
    expect(commandsFor({ code: "KeyJ", ctrl: true, shift: true }, "linux", rebound)).toEqual([]);
  });

  it("leaves a command whose first default is unscoped as it was", () => {
    const out = applyKeybindingOverrides(
      KEYBINDINGS,
      [{ command: COMMANDS.tabFocusPrev, primary: "CmdOrCtrl+Alt+Left" }],
      known,
    );
    expect(out.filter((b) => b.command === COMMANDS.tabFocusPrev)).toEqual([
      { command: COMMANDS.tabFocusPrev, primary: "CmdOrCtrl+Alt+Left" },
    ]);
  });
});

describe("findDisplayPrimary across platforms", () => {
  it("still shows a binding scoped by focus as well as platform", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.terminalNew, false, true)?.primary).toBe(
      "Ctrl+Shift+T",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.terminalNew, true)?.primary).toBe(
      "CmdOrCtrl+T",
    );
  });
});
