import { describe, expect, it } from "bun:test";
import { buildMenuTemplate, type MenuItemSpec } from "../../../src/main/features/menu/template";
import { ALL_COMMAND_IDS, COMMANDS } from "../../../src/shared/keybindings/commands";
import { detectConflicts } from "../../../src/shared/keybindings/conflicts";
import { EDITOR_COMMANDS } from "../../../src/shared/keybindings/editor-commands";
import {
  findDisplayPrimary,
  KEYBINDINGS,
  type KeybindingDecl,
} from "../../../src/shared/keybindings/index";
import {
  matchesKeyState,
  normalizeKeystroke,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybindings/keybinding-when";
import { applyKeybindingOverrides } from "../../../src/shared/keybindings/overrides";
import { RESERVED_KEYS } from "../../../src/shared/keybindings/reserved-keys";

type Platform = "darwin" | "win32" | "linux";

const platformKeys = (platform: Platform): Record<string, boolean> => ({
  isMac: platform === "darwin",
  isLinux: platform === "linux",
  isWindows: platform === "win32",
});

function firesOn(decl: KeybindingDecl, platform: Platform): boolean {
  if (decl.when === undefined) return true;
  const keys = platformKeys(platform);
  return evaluateWhen(parseWhen(decl.when), (k) => keys[k] === true);
}

function commandsFor(
  state: { code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean },
  platform: Platform,
  bindings: readonly KeybindingDecl[] = KEYBINDINGS,
): string[] {
  const s = { meta: false, ctrl: false, shift: false, alt: false, ...state };
  return bindings
    .filter(
      (b) =>
        b.primary !== undefined &&
        firesOn(b, platform) &&
        matchesKeyState(parseAccelerator(b.primary), s, platform === "darwin"),
    )
    .map((b) => b.command);
}

const ARROWS = [
  ["ArrowLeft", COMMANDS.tabFocusPrev],
  ["ArrowRight", COMMANDS.tabFocusNext],
  ["ArrowUp", COMMANDS.workspaceFocusPrev],
  ["ArrowDown", COMMANDS.workspaceFocusNext],
] as const;

const WINDOWS_KEYS = [
  ["Ctrl+Shift+PageUp", "PageUp", COMMANDS.workspaceFocusPrev],
  ["Ctrl+Shift+PageDown", "PageDown", COMMANDS.workspaceFocusNext],
] as const;

describe("moving between tabs and workspaces on Windows", () => {
  it("binds nothing to Win+Ctrl+arrows, which switch virtual desktops", () => {
    for (const [code] of ARROWS) {
      expect(commandsFor({ code, meta: true, ctrl: true }, "win32")).toEqual([]);
    }
  });

  it("moves between workspaces with Ctrl+Shift+PageUp/PageDown and tabs with Ctrl+PageUp/PageDown", () => {
    for (const [, code, command] of WINDOWS_KEYS) {
      expect(commandsFor({ code, ctrl: true, shift: true }, "win32")).toEqual([command]);
    }
    expect(commandsFor({ code: "PageUp", ctrl: true }, "win32")).toEqual([COMMANDS.tabFocusPrev]);
    expect(commandsFor({ code: "PageDown", ctrl: true }, "win32")).toEqual([COMMANDS.tabFocusNext]);
  });

  it("shows the Windows keys in Settings and the menu", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.workspaceFocusPrev, false)?.primary).toBe(
      "Ctrl+Shift+PageUp",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.workspaceFocusNext, false)?.primary).toBe(
      "Ctrl+Shift+PageDown",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.tabFocusPrev, false)?.primary).toBe(
      "Ctrl+PageUp",
    );
    expect(menuAccelerator("win32", COMMANDS.workspaceFocusPrev)).toBe("Ctrl+Shift+PageUp");
    expect(menuAccelerator("win32", COMMANDS.workspaceFocusNext)).toBe("Ctrl+Shift+PageDown");
  });

  it("takes no key another default, the OS or the editor uses on Windows", () => {
    const others = KEYBINDINGS.filter(
      (b) =>
        b.primary !== undefined &&
        firesOn(b, "win32") &&
        b.command !== COMMANDS.workspaceFocusPrev &&
        b.command !== COMMANDS.workspaceFocusNext,
    ).map((b) => normalizeKeystroke(b.primary as string, false));
    const reserved = RESERVED_KEYS.filter((r) => r.platform !== "mac").map((r) =>
      normalizeKeystroke(r.accelerator, false),
    );
    const editor = EDITOR_COMMANDS.flatMap((c) =>
      c.defaultPrimary ? [normalizeKeystroke(c.defaultPrimary, false)] : [],
    );
    for (const [key, , command] of WINDOWS_KEYS) {
      const norm = normalizeKeystroke(key, false);
      expect(others).not.toContain(norm);
      expect(reserved).not.toContain(norm);
      expect(editor).not.toContain(norm);
      expect(
        detectConflicts({ command, primary: key, bindings: KEYBINDINGS, isMac: false }),
      ).toEqual([]);
    }
  });
});

describe("macOS and Linux keep their keys", () => {
  it("keeps Cmd+Ctrl+arrows on macOS and Super+Ctrl+arrows on Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const [code, command] of ARROWS) {
        expect(commandsFor({ code, meta: true, ctrl: true }, platform)).toEqual([command]);
      }
      for (const [, code] of WINDOWS_KEYS) {
        expect(commandsFor({ code, ctrl: true, shift: true }, platform)).toEqual([]);
      }
    }
  });

  it("shows the same keys as before in Settings and the menu", () => {
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.workspaceFocusPrev, true)?.primary).toBe(
      "Cmd+Ctrl+Up",
    );
    expect(findDisplayPrimary(KEYBINDINGS, COMMANDS.workspaceFocusPrev, false, true)?.primary).toBe(
      "Cmd+Ctrl+Up",
    );
    expect(menuAccelerator("darwin", COMMANDS.workspaceFocusPrev)).toBe("Cmd+Ctrl+Up");
    expect(menuAccelerator("linux", COMMANDS.workspaceFocusPrev)).toBe("Cmd+Ctrl+Up");
  });

  it("doesn't count the Windows keys as a conflict on macOS", () => {
    for (const [key] of WINDOWS_KEYS) {
      expect(
        detectConflicts({
          command: "test.action",
          primary: key,
          bindings: KEYBINDINGS,
          isMac: true,
        }),
      ).toEqual([]);
    }
  });
});

describe("a shortcut the user set comes before the new default", () => {
  const known = new Set<string>(ALL_COMMAND_IDS);
  const primariesOf = (bindings: readonly KeybindingDecl[], command: string) =>
    bindings.filter((b) => b.command === command && b.primary !== undefined);

  it("replaces every default key of the command, on every platform", () => {
    const bindings = applyKeybindingOverrides(
      KEYBINDINGS,
      [{ command: COMMANDS.workspaceFocusPrev, primary: "CmdOrCtrl+Alt+9" }],
      known,
    );
    expect(primariesOf(bindings, COMMANDS.workspaceFocusPrev)).toEqual([
      { command: COMMANDS.workspaceFocusPrev, primary: "CmdOrCtrl+Alt+9" },
    ]);
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(commandsFor({ code: "Digit9", ctrl: true, alt: true }, platform, bindings)).toEqual(
        platform === "darwin" ? [] : [COMMANDS.workspaceFocusPrev],
      );
      expect(commandsFor({ code: "PageUp", ctrl: true, shift: true }, platform, bindings)).toEqual(
        [],
      );
    }
  });

  it("keeps a saved Cmd+Ctrl+Up as the user's key on Windows too, and an unbound one unbound", () => {
    const kept = applyKeybindingOverrides(
      KEYBINDINGS,
      [{ command: COMMANDS.workspaceFocusPrev, primary: "Cmd+Ctrl+Up" }],
      known,
    );
    expect(primariesOf(kept, COMMANDS.workspaceFocusPrev)).toEqual([
      { command: COMMANDS.workspaceFocusPrev, primary: "Cmd+Ctrl+Up" },
    ]);
    expect(commandsFor({ code: "ArrowUp", meta: true, ctrl: true }, "win32", kept)).toEqual([
      COMMANDS.workspaceFocusPrev,
    ]);
    const unbound = applyKeybindingOverrides(
      KEYBINDINGS,
      [{ command: COMMANDS.workspaceFocusPrev, primary: null }],
      known,
    );
    expect(primariesOf(unbound, COMMANDS.workspaceFocusPrev)).toEqual([]);
  });
});

function menuAccelerator(platform: Platform, command: string): string | undefined {
  const flatten = (specs: MenuItemSpec[]): MenuItemSpec[] =>
    specs.flatMap((s) => (s.type === "submenu" ? [s, ...flatten(s.submenu)] : [s]));
  const item = flatten(buildMenuTemplate({ platform, appName: "Nexus" })).find(
    (s) => s.type === "command" && s.command === command,
  );
  return item?.type === "command" ? item.accelerator : undefined;
}
