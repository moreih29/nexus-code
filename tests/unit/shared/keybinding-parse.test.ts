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
} from "../../../src/shared/keybinding-parse";

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
      shift: false,
      alt: false,
      codes: ["KeyW"],
    });
  });

  it("parses Shift+Enter (no cmd)", () => {
    expect(parseAccelerator("Shift+Enter")).toEqual({
      cmd: false,
      shift: true,
      alt: false,
      codes: ["Enter"],
    });
  });

  it("parses bare letter token U", () => {
    expect(parseAccelerator("U")).toEqual({
      cmd: false,
      shift: false,
      alt: false,
      codes: ["KeyU"],
    });
  });

  it("parses arrow keys", () => {
    expect(parseAccelerator("CmdOrCtrl+Alt+Left").codes).toEqual(["ArrowLeft"]);
  });

  it("treats backslash as accepting both Backslash and Slash (Korean keyboard parity)", () => {
    const p = parseAccelerator("CmdOrCtrl+\\");
    expect(p.codes.slice().sort()).toEqual(["Backslash", "Slash"]);
  });

  it("treats Cmd/Command/Ctrl/Control all as the cmd modifier", () => {
    expect(parseAccelerator("Cmd+W").cmd).toBe(true);
    expect(parseAccelerator("Command+W").cmd).toBe(true);
    expect(parseAccelerator("Ctrl+W").cmd).toBe(true);
    expect(parseAccelerator("Control+W").cmd).toBe(true);
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
    expect(
      matchesEvent(p, ev("Backslash", { metaKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    expect(matchesEvent(p, ev("Slash", { metaKey: true }) as unknown as KeyboardEvent)).toBe(true);
  });

  it("matches Shift+Enter without Cmd", () => {
    const p = parseAccelerator("Shift+Enter");
    expect(
      matchesEvent(p, ev("Enter", { shiftKey: true }) as unknown as KeyboardEvent),
    ).toBe(true);
    // ⌘⇧Enter must not match (extra modifier)
    expect(
      matchesEvent(p, ev("Enter", { shiftKey: true, metaKey: true }) as unknown as KeyboardEvent),
    ).toBe(false);
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
