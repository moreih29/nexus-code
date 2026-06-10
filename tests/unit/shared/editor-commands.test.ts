import { describe, expect, test } from "bun:test";
import { detectConflicts } from "../../../src/shared/keybindings/conflicts";
import {
  ALL_EDITOR_COMMAND_IDS,
  EDITOR_COMMANDS,
  editorCommandDefault,
} from "../../../src/shared/keybindings/editor-commands";
import { parseAccelerator } from "../../../src/shared/keybindings/keybinding-parse";

describe("editor command catalog", () => {
  test("command ids and slugs are unique", () => {
    const ids = EDITOR_COMMANDS.map((c) => c.id);
    const slugs = EDITOR_COMMANDS.map((c) => c.slug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("every declared default keystroke is a parseable accelerator", () => {
    for (const c of EDITOR_COMMANDS) {
      if (c.defaultPrimary === undefined) continue;
      expect(() => parseAccelerator(c.defaultPrimary as string)).not.toThrow();
    }
  });

  test("ALL_EDITOR_COMMAND_IDS mirrors the catalog", () => {
    expect(ALL_EDITOR_COMMAND_IDS.size).toBe(EDITOR_COMMANDS.length);
    for (const c of EDITOR_COMMANDS) expect(ALL_EDITOR_COMMAND_IDS.has(c.id)).toBe(true);
  });

  test("editorCommandDefault returns the declared default, or null when unbound", () => {
    expect(editorCommandDefault("editor.action.commentLine")).toBe("CmdOrCtrl+/");
    expect(editorCommandDefault("editor.action.duplicateSelection")).toBeNull();
    expect(editorCommandDefault("editor.action.nope")).toBeNull();
  });
});

describe("conflict engine over editor (string-id) bindings", () => {
  // The engine was generalized to plain string command ids so editor
  // (Monaco) commands reuse it. A capture colliding with another editor
  // command's key (both unscoped) is blocking.
  const bindings = [
    { command: "editor.action.moveLinesUpAction", primary: "Alt+Up" },
    { command: "editor.action.moveLinesDownAction", primary: "Alt+Down" },
  ];

  test("same keystroke as another editor command → blocking", () => {
    const conflicts = detectConflicts({
      command: "editor.action.moveLinesDownAction",
      primary: "Alt+Up", // collides with moveLinesUp
      bindings,
      isMac: true,
    });
    expect(
      conflicts.some(
        (c) => c.kind === "blocking" && c.command === "editor.action.moveLinesUpAction",
      ),
    ).toBe(true);
  });

  test("rebinding a command to its own key is not a self-conflict", () => {
    const conflicts = detectConflicts({
      command: "editor.action.moveLinesUpAction",
      primary: "Alt+Up",
      bindings,
      isMac: true,
    });
    // No blocking against itself; may still flag a reserved/shadow entry.
    expect(conflicts.some((c) => c.kind === "blocking")).toBe(false);
  });
});
