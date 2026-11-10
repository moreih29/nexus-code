/**
 * The keys that delete the file tree's selection: ⌘⌫ on the Mac, as in
 * Finder; Delete on Windows and Linux, as in their file managers, where
 * Ctrl+Backspace still works too. The label names the platform's key.
 */
import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../src/shared/keybindings/commands";
import { findDisplayPrimary, KEYBINDINGS } from "../../../src/shared/keybindings/index";
import { applyKeybindingOverrides } from "../../../src/shared/keybindings/overrides";

const shown = (isMac: boolean, isLinux = false, bindings = KEYBINDINGS) =>
  findDisplayPrimary(bindings, COMMANDS.fileDelete, isMac, isLinux)?.primary;

describe("file delete keys", () => {
  it("leave a user's key live on every platform", () => {
    const rebound = applyKeybindingOverrides(
      KEYBINDINGS,
      [{ command: COMMANDS.fileDelete, primary: "CmdOrCtrl+D" }],
      new Set(Object.values(COMMANDS)),
    );
    expect(rebound.filter((b) => b.command === COMMANDS.fileDelete)).toEqual([
      {
        command: COMMANDS.fileDelete,
        primary: "CmdOrCtrl+D",
        when: "fileTreeFocus && !inputFocus",
      },
    ]);
    expect(shown(true, false, rebound)).toBe("CmdOrCtrl+D");
    expect(shown(false, false, rebound)).toBe("CmdOrCtrl+D");
  });
});

describe("findDisplayPrimary and a platform named beside a focus", () => {
  it("never shows a binding scoped to another platform", () => {
    const bindings = [
      { command: COMMANDS.fileRename, primary: "Enter", when: "fileTreeFocus && isMac" },
      { command: COMMANDS.fileRename, primary: "F2", when: "fileTreeFocus" },
    ];
    expect(findDisplayPrimary(bindings, COMMANDS.fileRename, false)?.primary).toBe("F2");
    expect(findDisplayPrimary(bindings, COMMANDS.fileRename, true)?.primary).toBe("Enter");
  });
});
