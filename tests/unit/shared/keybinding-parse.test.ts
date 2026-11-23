import { describe, expect, it } from "bun:test";
import { matchesEvent, parseAccelerator } from "../../../src/shared/keybindings/keybinding-parse";

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

  it("treats backslash as accepting only the Backslash physical key", () => {
    const p = parseAccelerator("CmdOrCtrl+\\");
    expect(p.codes).toEqual(["Backslash"]);
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
  it("leaves AltGr to type its character on Win/Linux", () => {
    const p = parseAccelerator("CmdOrCtrl+Alt+C");
    const altGr = (state: boolean) =>
      ({
        ...ev("KeyC", { ctrlKey: true, altKey: true }),
        getModifierState: (key: string) => key === "AltGraph" && state,
      }) as unknown as KeyboardEvent;
    expect(matchesEvent(p, altGr(true), false)).toBe(false);
    expect(matchesEvent(p, altGr(false), false)).toBe(true);
  });

  it("matches CmdOrCtrl+W via metaKey on Mac", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(matchesEvent(p, ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, true)).toBe(
      true,
    );
  });

  it("matches CmdOrCtrl+W via ctrlKey on Win/Linux", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(matchesEvent(p, ev("KeyW", { ctrlKey: true }) as unknown as KeyboardEvent, false)).toBe(
      true,
    );
  });

  it("rejects CmdOrCtrl+R on bare ⌃R on Mac (xterm Ctrl-letter shortcuts pass through)", () => {
    const p = parseAccelerator("CmdOrCtrl+R");
    expect(matchesEvent(p, ev("KeyR", { ctrlKey: true }) as unknown as KeyboardEvent, true)).toBe(
      false,
    );
  });

  it("rejects CmdOrCtrl+R on bare ⌘R on Win/Linux", () => {
    const p = parseAccelerator("CmdOrCtrl+R");
    expect(matchesEvent(p, ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent, false)).toBe(
      false,
    );
  });

  it("rejects CmdOrCtrl+W when Shift is also held", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(
      matchesEvent(
        p,
        ev("KeyW", { metaKey: true, shiftKey: true }) as unknown as KeyboardEvent,
        true,
      ),
    ).toBe(false);
  });

  it("rejects CmdOrCtrl+W when both Cmd and Ctrl are held (ambiguous, reserved for Cmd+Ctrl bindings)", () => {
    const p = parseAccelerator("CmdOrCtrl+W");
    expect(
      matchesEvent(
        p,
        ev("KeyW", { metaKey: true, ctrlKey: true }) as unknown as KeyboardEvent,
        true,
      ),
    ).toBe(false);
  });

  it("matches plain U with no modifiers (chord secondary)", () => {
    const p = parseAccelerator("U");
    expect(matchesEvent(p, ev("KeyU") as unknown as KeyboardEvent, true)).toBe(true);
  });

  it("rejects U when Cmd is held (prevents ⌘U from completing chord that wants plain U)", () => {
    const p = parseAccelerator("U");
    expect(matchesEvent(p, ev("KeyU", { metaKey: true }) as unknown as KeyboardEvent, true)).toBe(
      false,
    );
  });

  it("matches CmdOrCtrl+\\ only on the Backslash physical key (Mac)", () => {
    const p = parseAccelerator("CmdOrCtrl+\\");
    expect(
      matchesEvent(p, ev("Backslash", { metaKey: true }) as unknown as KeyboardEvent, true),
    ).toBe(true);
    expect(matchesEvent(p, ev("Slash", { metaKey: true }) as unknown as KeyboardEvent, true)).toBe(
      false,
    );
  });

  it("matches Shift+Enter without Cmd", () => {
    const p = parseAccelerator("Shift+Enter");
    expect(matchesEvent(p, ev("Enter", { shiftKey: true }) as unknown as KeyboardEvent, true)).toBe(
      true,
    );
    expect(
      matchesEvent(
        p,
        ev("Enter", { shiftKey: true, metaKey: true }) as unknown as KeyboardEvent,
        true,
      ),
    ).toBe(false);
  });

  it("matches Cmd+Ctrl+Up only when both metaKey and ctrlKey are held", () => {
    const p = parseAccelerator("Cmd+Ctrl+Up");
    expect(
      matchesEvent(
        p,
        ev("ArrowUp", { metaKey: true, ctrlKey: true }) as unknown as KeyboardEvent,
        true,
      ),
    ).toBe(true);
    expect(
      matchesEvent(p, ev("ArrowUp", { metaKey: true }) as unknown as KeyboardEvent, true),
    ).toBe(false);
    expect(
      matchesEvent(p, ev("ArrowUp", { ctrlKey: true }) as unknown as KeyboardEvent, true),
    ).toBe(false);
    expect(
      matchesEvent(
        p,
        ev("ArrowUp", {
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
        }) as unknown as KeyboardEvent,
        true,
      ),
    ).toBe(false);
  });

  it("matches bare Ctrl+W on ctrlKey only, on either OS", () => {
    const p = parseAccelerator("Ctrl+W");
    expect(matchesEvent(p, ev("KeyW", { ctrlKey: true }) as unknown as KeyboardEvent, true)).toBe(
      true,
    );
    expect(matchesEvent(p, ev("KeyW", { ctrlKey: true }) as unknown as KeyboardEvent, false)).toBe(
      true,
    );
    expect(matchesEvent(p, ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, true)).toBe(
      false,
    );
  });

  it("matches Cmd+, on Comma key with metaKey (Mac)", () => {
    const p = parseAccelerator("Cmd+,");
    expect(matchesEvent(p, ev("Comma", { metaKey: true }) as unknown as KeyboardEvent, true)).toBe(
      true,
    );
    expect(matchesEvent(p, ev("Comma") as unknown as KeyboardEvent, true)).toBe(false);
  });
});
