import { describe, expect, test } from "bun:test";
import {
  type ConflictBinding,
  detectTableConflicts,
} from "../../../src/shared/keybindings/conflicts";
import { KEYBINDINGS } from "../../../src/shared/keybindings/index";

describe("detectTableConflicts — persistent, table-wide view", () => {
  test("no collisions → empty map", () => {
    const bindings: ConflictBinding[] = [
      { command: "a", primary: "CmdOrCtrl+K" },
      { command: "b", primary: "CmdOrCtrl+J" },
    ];
    expect(detectTableConflicts(bindings, true).size).toBe(0);
  });

  test("two unscoped commands on the same key → BOTH rows flagged (blocking)", () => {
    // Also the indirect-conflict case: X was moved off ⌘K, Y was set to ⌘K,
    // then X was reset back to its ⌘K default. The old record-time check only
    // ran while editing, so it showed nothing here.
    const bindings: ConflictBinding[] = [
      { command: "a", primary: "CmdOrCtrl+K" },
      { command: "b", primary: "CmdOrCtrl+K" },
    ];
    const map = detectTableConflicts(bindings, true);
    // Symmetric: both participants get an entry so each row can badge.
    expect(map.get("a")?.[0]?.kind).toBe("blocking");
    expect(map.get("a")?.[0]?.command).toBe("b");
    expect(map.get("b")?.[0]?.command).toBe("a");
  });

  test("same key but differing (non-disjoint) scopes → overlap, not blocking", () => {
    const bindings: ConflictBinding[] = [
      { command: "a", primary: "CmdOrCtrl+R", when: "fileTreeFocus" },
      { command: "b", primary: "CmdOrCtrl+R", when: "inputFocus" },
    ];
    const map = detectTableConflicts(bindings, true);
    // fileTreeFocus and inputFocus are not provably exclusive, so the check
    // stays conservative and warns.
    expect(map.get("a")?.[0]?.kind).toBe("overlap");
  });

  test("reserved/shadow collisions are excluded from the table view (record-time only)", () => {
    // ⌘/ shadows Monaco's comment toggle, but a single binding on it is not
    // a command-vs-command conflict — the table view stays quiet.
    const bindings: ConflictBinding[] = [{ command: "a", primary: "CmdOrCtrl+/" }];
    expect(detectTableConflicts(bindings, true).size).toBe(0);
  });

  test("provably-disjoint scopes (X vs !X) are NOT flagged — browser-tab routing", () => {
    // The shape our ⌘R / ⌘⇧R defaults actually ship with: same key, but
    // gated on browserTabActive vs !browserTabActive — mutually exclusive,
    // so never a real collision.
    const r: ConflictBinding[] = [
      {
        command: "files.refresh",
        primary: "CmdOrCtrl+R",
        when: "!browserTabActive && (!terminalFocus || isMac)",
      },
      { command: "browser.reload", primary: "CmdOrCtrl+R", when: "browserTabActive" },
    ];
    expect(detectTableConflicts(r, true).size).toBe(0);

    const shiftR: ConflictBinding[] = [
      { command: "files.refresh", primary: "CmdOrCtrl+Shift+R", when: "!browserTabActive" },
      { command: "browser.hardReload", primary: "CmdOrCtrl+Shift+R", when: "browserTabActive" },
    ];
    expect(detectTableConflicts(shiftR, true).size).toBe(0);
  });

  test("the shipped default KEYBINDINGS table has ZERO conflicts on both platforms", () => {
    expect(detectTableConflicts(KEYBINDINGS, true).size).toBe(0);
    expect(detectTableConflicts(KEYBINDINGS, false).size).toBe(0);
  });
});
