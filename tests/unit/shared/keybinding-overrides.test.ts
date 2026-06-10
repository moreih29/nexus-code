/**
 * Pure tests for the user-override layer: schema validation, the
 * defaults+delta merge, the conflict engine, and the recorder's
 * event→accelerator reverse function.
 */
import { describe, expect, it } from "bun:test";
import { detectConflicts } from "../../../src/shared/keybindings/conflicts";
import type { KeybindingDecl } from "../../../src/shared/keybindings/index";
import {
  eventToAccelerator,
  matchesEvent,
  normalizeKeystroke,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";
import {
  applyKeybindingOverrides,
  KeybindingOverridesSchema,
  removeOverride,
  upsertOverride,
} from "../../../src/shared/keybindings/overrides";
import { findReservedKey } from "../../../src/shared/keybindings/reserved-keys";

const KNOWN = new Set(["tab.close", "file.open", "file.save", "tab.closeAll", "files.refresh"]);

const DEFAULTS: readonly KeybindingDecl[] = [
  { command: "tab.close" as never, primary: "CmdOrCtrl+W", when: "!terminalFocus || isMac" },
  { command: "file.open" as never, primary: "CmdOrCtrl+E" },
  { command: "file.open" as never, primary: "CmdOrCtrl+O" },
  { command: "tab.closeAll" as never, chord: ["CmdOrCtrl+K", "CmdOrCtrl+W"] },
  { command: "files.refresh" as never, primary: "CmdOrCtrl+R", when: "!browserTabActive" },
];

describe("KeybindingOverridesSchema", () => {
  it("accepts replace / unbind / chord entries", () => {
    const parsed = KeybindingOverridesSchema.parse([
      { command: "tab.close", primary: "CmdOrCtrl+Shift+X" },
      { command: "file.open", primary: null },
      { command: "tab.closeAll", chord: ["CmdOrCtrl+K", "A"] },
    ]);
    expect(parsed).toHaveLength(3);
  });

  it("rejects unparseable accelerator strings at the boundary", () => {
    expect(() =>
      KeybindingOverridesSchema.parse([{ command: "tab.close", primary: "Cmd+NotAKey" }]),
    ).toThrow();
    expect(() =>
      KeybindingOverridesSchema.parse([{ command: "tab.close", primary: "CmdOrCtrl+W+S" }]),
    ).toThrow();
  });

  it("accepts unknown command ids (version-skew tolerance)", () => {
    // Unknown ids must validate — they are dropped at APPLY time, not
    // parse time, so a stale state.json never fails wholesale.
    const parsed = KeybindingOverridesSchema.parse([
      { command: "future.command", primary: "CmdOrCtrl+9" },
    ]);
    expect(parsed).toHaveLength(1);
  });
});

describe("applyKeybindingOverrides", () => {
  it("returns defaults untouched for empty/undefined overrides", () => {
    expect(applyKeybindingOverrides(DEFAULTS, undefined, KNOWN)).toEqual([...DEFAULTS]);
    expect(applyKeybindingOverrides(DEFAULTS, [], KNOWN)).toEqual([...DEFAULTS]);
  });

  it("replaces a primary in place and inherits the default `when`", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "tab.close", primary: "CmdOrCtrl+Shift+X" }],
      KNOWN,
    );
    const tabClose = out.filter((b) => b.command === "tab.close");
    expect(tabClose).toHaveLength(1);
    expect(tabClose[0]?.primary).toBe("CmdOrCtrl+Shift+X");
    expect(tabClose[0]?.when).toBe("!terminalFocus || isMac");
    // position preserved: still first in the table
    expect(out[0]?.command).toBe("tab.close");
  });

  it("collapses multi-declaration commands to one replacement", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "file.open", primary: "CmdOrCtrl+P" }],
      KNOWN,
    );
    const fileOpen = out.filter((b) => b.command === "file.open");
    expect(fileOpen).toHaveLength(1);
    expect(fileOpen[0]?.primary).toBe("CmdOrCtrl+P");
  });

  it("unbinds with null (drops every default primary)", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "file.open", primary: null }],
      KNOWN,
    );
    expect(out.some((b) => b.command === "file.open")).toBe(false);
  });

  it("replaces a chord", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "tab.closeAll", chord: ["CmdOrCtrl+K", "A"] }],
      KNOWN,
    );
    const decl = out.find((b) => b.command === "tab.closeAll");
    expect(decl?.chord).toEqual(["CmdOrCtrl+K", "A"]);
  });

  it("drops overrides for unknown commands", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "ghost.command", primary: "CmdOrCtrl+9" }],
      KNOWN,
    );
    expect(out).toEqual([...DEFAULTS]);
  });

  it("adds a primary to a chord-only command (appended)", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [{ command: "tab.closeAll", primary: "CmdOrCtrl+9" }],
      KNOWN,
    );
    const decls = out.filter((b) => b.command === "tab.closeAll");
    // default chord retained + appended primary decl
    expect(decls.some((d) => d.chord !== undefined)).toBe(true);
    expect(decls.some((d) => d.primary === "CmdOrCtrl+9")).toBe(true);
  });

  it("last override entry per command wins", () => {
    const out = applyKeybindingOverrides(
      DEFAULTS,
      [
        { command: "tab.close", primary: "CmdOrCtrl+1" },
        { command: "tab.close", primary: "CmdOrCtrl+2" },
      ],
      KNOWN,
    );
    expect(out.find((b) => b.command === "tab.close")?.primary).toBe("CmdOrCtrl+2");
  });
});

describe("upsertOverride / removeOverride", () => {
  it("merges field-wise and removes empty entries", () => {
    let list = upsertOverride([], { command: "tab.close", primary: "CmdOrCtrl+1" });
    list = upsertOverride(list, { command: "tab.close", chord: ["CmdOrCtrl+K", "X"] });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      command: "tab.close",
      primary: "CmdOrCtrl+1",
      chord: ["CmdOrCtrl+K", "X"],
    });
    expect(removeOverride(list, "tab.close")).toHaveLength(0);
  });
});

describe("normalizeKeystroke", () => {
  it("resolves CmdOrCtrl per platform", () => {
    expect(normalizeKeystroke("CmdOrCtrl+R", true)).toBe("meta+KeyR");
    expect(normalizeKeystroke("CmdOrCtrl+R", false)).toBe("ctrl+KeyR");
    expect(normalizeKeystroke("Ctrl+R", true)).toBe("ctrl+KeyR");
    expect(normalizeKeystroke("Cmd+Ctrl+Up", true)).toBe("meta+ctrl+ArrowUp");
  });

  it("returns null for unparseable input", () => {
    expect(normalizeKeystroke("Nope+X+Y", true)).toBeNull();
  });

  it("collides CmdOrCtrl+R with Ctrl+R on Win/Linux but not Mac", () => {
    expect(normalizeKeystroke("CmdOrCtrl+R", false)).toBe(normalizeKeystroke("Ctrl+R", false));
    expect(normalizeKeystroke("CmdOrCtrl+R", true)).not.toBe(normalizeKeystroke("Ctrl+R", true));
  });
});

describe("findReservedKey", () => {
  it("flags Monaco's comment toggle (the ⌘/ regression, as data)", () => {
    const hit = findReservedKey("CmdOrCtrl+/", true);
    expect(hit?.source).toBe("monaco");
  });

  it("flags shell keys via the platform-resolved form", () => {
    // CmdOrCtrl+R IS Ctrl+R on Win/Linux → terminal reservation hits…
    expect(findReservedKey("CmdOrCtrl+R", false)?.source).toBe("terminal");
    // …but on Mac it's ⌘R, which no built-in owns.
    expect(findReservedKey("CmdOrCtrl+R", true)).toBeUndefined();
  });

  it("flags macOS system keys only on Mac", () => {
    expect(findReservedKey("Cmd+Q", true)?.source).toBe("system");
    // On Win/Linux the mac-only system entry is skipped — but Cmd+Q
    // normalizes to Ctrl+Q there, which the shell owns (XON). The
    // platform filter correctly degrades the hit, not the protection.
    expect(findReservedKey("Cmd+Q", false)?.source).toBe("terminal");
  });
});

describe("detectConflicts", () => {
  const isMac = true;

  it("blocks a duplicate keystroke when either side is unscoped", () => {
    const conflicts = detectConflicts({
      command: "file.save" as never,
      primary: "CmdOrCtrl+E", // file.open's key, file.open is unscoped
      bindings: DEFAULTS,
      isMac,
    });
    expect(conflicts.some((c) => c.kind === "blocking" && c.command === "file.open")).toBe(true);
  });

  it("grades differing non-empty scopes as overlap, not blocking", () => {
    const conflicts = detectConflicts({
      command: "file.save" as never,
      primary: "CmdOrCtrl+R",
      when: "editorFocus",
      bindings: DEFAULTS,
      isMac,
    });
    const hit = conflicts.find((c) => c.command === ("files.refresh" as never));
    expect(hit?.kind).toBe("overlap");
  });

  it("blocks a primary that equals another command's chord leader", () => {
    const conflicts = detectConflicts({
      command: "file.save" as never,
      primary: "CmdOrCtrl+K",
      bindings: DEFAULTS,
      isMac,
    });
    expect(conflicts.some((c) => c.kind === "blocking" && c.command === "tab.closeAll")).toBe(true);
  });

  it("reports shadow for built-in keys and system for OS keys", () => {
    const shadow = detectConflicts({
      command: "file.save" as never,
      primary: "CmdOrCtrl+/",
      bindings: DEFAULTS,
      isMac,
    });
    expect(shadow.some((c) => c.kind === "shadow" && c.reserved?.source === "monaco")).toBe(true);

    const system = detectConflicts({
      command: "file.save" as never,
      primary: "Cmd+Q",
      bindings: DEFAULTS,
      isMac,
    });
    expect(system.some((c) => c.kind === "system")).toBe(true);
  });

  it("returns nothing for a clean keystroke", () => {
    const conflicts = detectConflicts({
      command: "file.save" as never,
      primary: "CmdOrCtrl+Shift+9",
      bindings: DEFAULTS,
      isMac,
    });
    expect(conflicts).toHaveLength(0);
  });

  it("ignores the command's own existing binding (self-conflict)", () => {
    const conflicts = detectConflicts({
      command: "tab.close" as never,
      primary: "CmdOrCtrl+W",
      bindings: DEFAULTS,
      isMac,
    });
    expect(conflicts.some((c) => c.command === ("tab.close" as never))).toBe(false);
  });
});

describe("eventToAccelerator", () => {
  interface MockKE {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    code: string;
  }
  function ev(code: string, mods: Partial<Omit<MockKE, "code">> = {}): KeyboardEvent {
    return {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      code,
      ...mods,
    } as unknown as KeyboardEvent;
  }

  it("maps ⌘⇧X on Mac and Ctrl+Shift+X on Win/Linux", () => {
    expect(eventToAccelerator(ev("KeyX", { metaKey: true, shiftKey: true }), true)).toBe(
      "CmdOrCtrl+Shift+X",
    );
    expect(eventToAccelerator(ev("KeyX", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "CmdOrCtrl+Shift+X",
    );
  });

  it("keeps literal Ctrl and Cmd+Ctrl distinct on Mac", () => {
    expect(eventToAccelerator(ev("KeyR", { ctrlKey: true }), true)).toBe("Ctrl+R");
    expect(eventToAccelerator(ev("ArrowUp", { metaKey: true, ctrlKey: true }), true)).toBe(
      "Cmd+Ctrl+Up",
    );
  });

  it("rejects modifier-only, unknown codes, and Win-key combos", () => {
    expect(eventToAccelerator(ev("MetaLeft", { metaKey: true }), true)).toBeNull();
    expect(eventToAccelerator(ev("NumpadAdd", { metaKey: true }), true)).toBeNull();
    expect(eventToAccelerator(ev("KeyX", { metaKey: true }), false)).toBeNull();
  });

  it("round-trips through parseAccelerator + matchesEvent", () => {
    const cases: Array<[KeyboardEvent, boolean]> = [
      [ev("KeyW", { metaKey: true }), true],
      [ev("Backslash", { metaKey: true, shiftKey: true }), true],
      [ev("BracketLeft", { metaKey: true }), true],
      [ev("F2"), true],
      [ev("KeyR", { ctrlKey: true }), false],
      [ev("Slash", { ctrlKey: true, altKey: true }), false],
    ];
    for (const [event, isMac] of cases) {
      const accel = eventToAccelerator(event, isMac);
      expect(accel).not.toBeNull();
      if (accel === null) continue;
      expect(matchesEvent(parseAccelerator(accel), event, isMac)).toBe(true);
    }
  });
});
