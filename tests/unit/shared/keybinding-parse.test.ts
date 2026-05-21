/**
 * Pure tests for the accelerator parser. No DOM; we hand-roll
 * KeyboardEvent-shaped objects to satisfy `matchesEvent`.
 */
import { describe, expect, it } from "bun:test";
import {
  acceleratorToLabel,
  chordToLabel,
  matchesEvent,
  parseAccelerator,
} from "../../../src/shared/keybindings/keybinding-parse";

interface MockKE {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}
function ev(code: string, mods: Partial<Omit<MockKE, "code">> = {}): MockKE {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    code,
    ...mods,
  };
}

describe("parseAccelerator", () => {
  it("parses CmdOrCtrl+W", () => {
    expect(parseAccelerator("CmdOrCtrl+W")).toEqual({
      cmd: true,
      ctrl: false,
      shift: false,
      alt: false,
      codes: ["KeyW"],
    });
  });

  it("parses Shift+Enter (no cmd)", () => {
    expect(parseAccelerator("Shift+Enter")).toEqual({
      cmd: false,
      ctrl: false,
      shift: true,
      alt: false,
      codes: ["Enter"],
    });
  });

  it("parses bare letter token U", () => {
    expect(parseAccelerator("U")).toEqual({
      cmd: false,
      ctrl: false,
      shift: false,
      alt: false,
      codes: ["KeyU"],
    });
  });

  it("parses Cmd+Ctrl+Up as a literal two-modifier combo (Mac)", () => {
    expect(parseAccelerator("Cmd+Ctrl+Up")).toEqual({
      cmd: true,
      ctrl: true,
      shift: false,
      alt: false,
      codes: ["ArrowUp"],
    });
  });

  it("parses Cmd+, with comma as the key token", () => {
    expect(parseAccelerator("Cmd+,")).toEqual({
      cmd: true,
      ctrl: false,
      shift: false,
      alt: false,
      codes: ["Comma"],
    });
  });

  it("parses arrow keys", () => {
    expect(parseAccelerator("CmdOrCtrl+Alt+Left").codes).toEqual(["ArrowLeft"]);
  });

  it("treats backslash as accepting both Backslash and Slash (Korean keyboard parity)", () => {
    const p = parseAccelerator("CmdOrCtrl+\\");
    expect(p.codes.slice().sort()).toEqual(["Backslash", "Slash"]);
  });

  it("treats CmdOrCtrl/Cmd/Command/Meta as the cmd modifier", () => {
    expect(parseAccelerator("CmdOrCtrl+W").cmd).toBe(true);
    expect(parseAccelerator("Cmd+W").cmd).toBe(true);
    expect(parseAccelerator("Command+W").cmd).toBe(true);
    expect(parseAccelerator("Meta+W").cmd).toBe(true);
  });

  it("treats bare Ctrl/Control as the literal ctrl modifier (separate from cmd)", () => {
    const ctrl = parseAccelerator("Ctrl+W");
    expect(ctrl.cmd).toBe(false);
    expect(ctrl.ctrl).toBe(true);
    const control = parseAccelerator("Control+W");
    expect(control.cmd).toBe(false);
    expect(control.ctrl).toBe(true);
  });

  it("rejects accelerators with two key tokens", () => {
    expect(() => parseAccelerator("CmdOrCtrl+W+S")).toThrow();
  });

  it("rejects accelerators with no key token", () => {
    expect(() => parseAccelerator("CmdOrCtrl+Shift")).toThrow();
  });
});

describe("matchesEvent", () => {
  it("matches Cmd+W via metaKey on Mac", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(matchesEvent(p, ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent)).toBe(true);
  });

  it("matches Cmd+W via ctrlKey on Win/Linux", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(matchesEvent(p, ev("KeyW", { ctrlKey: true }) as unknown as KeyboardEvent)).toBe(true);
  });

  it("rejects Cmd+W when Shift is also held", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(
      matchesEvent(p, ev("KeyW", { metaKey: true, shiftKey: true }) as unknown as KeyboardEvent),
    ).toBe(false);
  });

  it("rejects Cmd+W when both Cmd and Ctrl are held (ambiguous)", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(
      matchesEvent(p, ev("KeyW", { metaKey: true, ctrlKey: true }) as unknown as KeyboardEvent),
    ).toBe(false);
  });

  it("matches plain U with no modifiers (chord secondary)", () => {
    const p = parseAccelerator("U");
    expect(matchesEvent(p, ev("KeyU") as unknown as KeyboardEvent)).toBe(true);
  });

  it("rejects U when Cmd is held (prevents ⌘U from completing chord that wants plain U)", () => {
    const p = parseAccelerator("U");
    expect(matchesEvent(p, ev("KeyU", { metaKey: true }) as unknown as KeyboardEvent)).toBe(false);
  });

  it("matches CmdOrCtrl+\\ on both Backslash and Slash physical keys", () => {
    const p = parseAccelerator("CmdOrCtrl+\\");
    expect(matchesEvent(p, ev("Backslash", { metaKey: true }) as unknown as KeyboardEvent)).toBe(
      true,
    );
    expect(matchesEvent(p, ev("Slash", { metaKey: true }) as unknown as KeyboardEvent)).toBe(true);
  });

  it("matches Shift+Enter without Cmd", () => {
    const p = parseAccelerator("Shift+Enter");
    expect(matchesEvent(p, ev("Enter", { shiftKey: true }) as unknown as KeyboardEvent)).toBe(true);
    // ⌘⇧Enter must not match (extra modifier)
    expect(
      matchesEvent(p, ev("Enter", { shiftKey: true, metaKey: true }) as unknown as KeyboardEvent),
    ).toBe(false);
  });

  it("matches Cmd+Ctrl+Up only when both metaKey and ctrlKey are held", () => {
    const p = parseAccelerator("Cmd+Ctrl+Up");
    // both modifiers held → match
    expect(
      matchesEvent(
        p,
        ev("ArrowUp", { metaKey: true, ctrlKey: true }) as unknown as KeyboardEvent,
      ),
    ).toBe(true);
    // only meta → no match (this is what CmdOrCtrl+Up would catch instead)
    expect(matchesEvent(p, ev("ArrowUp", { metaKey: true }) as unknown as KeyboardEvent)).toBe(
      false,
    );
    // only ctrl → no match
    expect(matchesEvent(p, ev("ArrowUp", { ctrlKey: true }) as unknown as KeyboardEvent)).toBe(
      false,
    );
    // adding shift breaks the match (strict modifier set)
    expect(
      matchesEvent(
        p,
        ev("ArrowUp", {
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
        }) as unknown as KeyboardEvent,
      ),
    ).toBe(false);
  });

  it("matches Cmd+, on Comma key with metaKey", () => {
    const p = parseAccelerator("Cmd+,");
    expect(matchesEvent(p, ev("Comma", { metaKey: true }) as unknown as KeyboardEvent)).toBe(true);
    expect(matchesEvent(p, ev("Comma") as unknown as KeyboardEvent)).toBe(false);
  });
});

describe("acceleratorToLabel", () => {
  it("renders Cmd+W as ⌘W on Mac", () => {
    expect(acceleratorToLabel("CmdOrCtrl+W", { isMac: true })).toBe("⌘W");
  });

  it("renders Cmd+W as Ctrl+W on Win/Linux", () => {
    expect(acceleratorToLabel("CmdOrCtrl+W", { isMac: false })).toBe("Ctrl+W");
  });

  it("renders Cmd+Alt+R as ⌘⌥R on Mac", () => {
    expect(acceleratorToLabel("CmdOrCtrl+Alt+R", { isMac: true })).toBe("⌘⌥R");
  });

  it("renders arrow keys as arrows on Mac", () => {
    expect(acceleratorToLabel("CmdOrCtrl+Alt+Left", { isMac: true })).toBe("⌘⌥←");
  });

  it("renders Shift+Enter as ⇧↵ on Mac", () => {
    expect(acceleratorToLabel("Shift+Enter", { isMac: true })).toBe("⇧↵");
  });

  it("renders Cmd+Ctrl+Up as ⌘⌃↑ on Mac", () => {
    expect(acceleratorToLabel("Cmd+Ctrl+Up", { isMac: true })).toBe("⌘⌃↑");
  });

  it("renders Cmd+, with a literal comma", () => {
    expect(acceleratorToLabel("Cmd+,", { isMac: true })).toBe("⌘,");
    expect(acceleratorToLabel("Cmd+,", { isMac: false })).toBe("⌘+,");
  });
});

describe("chordToLabel", () => {
  it("joins two halves with a space on Mac", () => {
    expect(chordToLabel(["CmdOrCtrl+K", "CmdOrCtrl+W"], { isMac: true })).toBe("⌘K ⌘W");
  });

  it("joins two halves with a space on Win/Linux", () => {
    expect(chordToLabel(["CmdOrCtrl+K", "CmdOrCtrl+W"], { isMac: false })).toBe("Ctrl+K Ctrl+W");
  });

  it("renders ⌘K U for plain-letter secondary", () => {
    expect(chordToLabel(["CmdOrCtrl+K", "U"], { isMac: true })).toBe("⌘K U");
  });
});
