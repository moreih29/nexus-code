/**
 * Unit tests for src/renderer/keybindings/global.ts
 *
 * The router resolves keystrokes to command IDs and dispatches through
 * the command registry. Tests register fake handlers per command and
 * assert that the right one fires for each shortcut. No DOM, no React.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { COMMANDS } from "../../../../src/shared/commands";
import { __resetCommandsForTests, registerCommand } from "../../../../src/renderer/commands/registry";
import {
  __resetChordStateForTests,
  __setChordClockForTests,
  handleGlobalKeyDown,
  isInEditable,
} from "../../../../src/renderer/keybindings/global";

interface MockEvent {
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  code: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function makeEvent(
  key: string,
  opts: {
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    code?: string;
    target?: unknown;
  } = {},
): MockEvent {
  let prevented = false;
  return {
    key,
    code: opts.code ?? "",
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    target: opts.target ?? null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

function setupCommandSpies(): Record<string, ReturnType<typeof mock>> {
  const spies: Record<string, ReturnType<typeof mock>> = {};
  for (const id of Object.values(COMMANDS)) {
    const fn = mock(() => {});
    spies[id] = fn;
    registerCommand(id, fn as () => void);
  }
  return spies;
}

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

// ---------------------------------------------------------------------------
// isInEditable
// ---------------------------------------------------------------------------

describe("isInEditable", () => {
  it("returns true for INPUT element", () => {
    expect(isInEditable({ tagName: "INPUT" } as HTMLElement)).toBe(true);
  });

  it("returns true for TEXTAREA element", () => {
    expect(isInEditable({ tagName: "TEXTAREA" } as HTMLElement)).toBe(true);
  });

  it("returns true for contentEditable element", () => {
    const el = {
      tagName: "DIV",
      isContentEditable: true,
      closest: () => null,
    } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(true);
  });

  it("returns true when element is inside .cm-editor", () => {
    const el = {
      tagName: "SPAN",
      isContentEditable: false,
      closest: (sel: string) => (sel === ".cm-editor" ? {} : null),
    } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(true);
  });

  it("returns false for a plain non-editable DIV", () => {
    const el = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(false);
  });

  it("returns false for null target", () => {
    expect(isInEditable(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — file commands
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — refresh", () => {
  it("fires files.refresh on Cmd+R", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: true });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("still fires files.refresh inside an editable (matches the prior page-reload override)", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("r", { metaKey: true, target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not fire on plain r without modifier", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: false });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).not.toHaveBeenCalled();
  });
});

describe("handleGlobalKeyDown — fileOpen editable guard", () => {
  it("does not fire file.open when target is INPUT", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("e", { metaKey: true, code: "KeyE", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.fileOpen]).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("fires file.open on Cmd+E for non-editable target", () => {
    const spies = setupCommandSpies();
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("e", { metaKey: true, code: "KeyE", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.fileOpen]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("fires file.open on Cmd+O for non-editable target", () => {
    const spies = setupCommandSpies();
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("o", { metaKey: true, code: "KeyO", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.fileOpen]).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — split (Backslash / Slash for Korean keyboards)
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — split", () => {
  it("fires group.splitRight on Cmd+\\ (code=Backslash)", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("\\", { metaKey: true, code: "Backslash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("fires group.splitRight on Cmd+/ (code=Slash) — Korean keyboard", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("/", { metaKey: true, code: "Slash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).toHaveBeenCalledTimes(1);
  });

  it("fires group.splitDown on Cmd+Shift+\\", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("\\", { metaKey: true, shiftKey: true, code: "Backslash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitDown]).toHaveBeenCalledTimes(1);
  });

  it("does not fire split when altKey is set (would clash with Cmd+Alt+...)", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("\\", { metaKey: true, altKey: true, code: "Backslash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).not.toHaveBeenCalled();
  });

  it("does not fire split when target is INPUT", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("\\", { metaKey: true, code: "Backslash", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — tab close family
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — tab close", () => {
  it("Cmd+Shift+W fires group.close (more specific match wins over Cmd+W)", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("w", { metaKey: true, shiftKey: true, code: "KeyW" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupClose]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.tabClose]).not.toHaveBeenCalled();
  });

  it("Cmd+W fires tab.close", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("w", { metaKey: true, code: "KeyW" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabClose]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.groupClose]).not.toHaveBeenCalled();
  });

  it("Cmd+Alt+T fires tab.closeOthers", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("t", { metaKey: true, altKey: true, code: "KeyT" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabCloseOthers]).toHaveBeenCalledTimes(1);
  });
});

describe("handleGlobalKeyDown — path actions", () => {
  it("Cmd+Alt+R fires path.reveal", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: true, altKey: true, code: "KeyR" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.pathReveal]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.filesRefresh]).not.toHaveBeenCalled();
  });

  it("Cmd+Alt+C fires path.copy", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("c", { metaKey: true, altKey: true, code: "KeyC" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.pathCopy]).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Shift+Alt+C fires path.copyRelative", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("c", {
      metaKey: true,
      shiftKey: true,
      altKey: true,
      code: "KeyC",
    });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.pathCopyRelative]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.pathCopy]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — KeyChord (⌘K …)
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — KeyChord", () => {
  it("Cmd+K alone enters pending state and fires no command", () => {
    const spies = setupCommandSpies();
    const leader = makeEvent("k", { metaKey: true, code: "KeyK" });
    handleGlobalKeyDown(leader as unknown as KeyboardEvent);
    expect(leader.defaultPrevented).toBe(true);
    for (const id of Object.values(COMMANDS)) {
      expect(spies[id]).not.toHaveBeenCalled();
    }
  });

  it("Cmd+K then U fires tab.closeSaved", () => {
    const spies = setupCommandSpies();
    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    const second = makeEvent("u", { code: "KeyU" });
    handleGlobalKeyDown(second as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabCloseSaved]).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(true);
  });

  it("Cmd+K then Cmd+W fires tab.closeAll (not tab.close)", () => {
    const spies = setupCommandSpies();
    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    const second = makeEvent("w", { metaKey: true, code: "KeyW" });
    handleGlobalKeyDown(second as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabCloseAll]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.tabClose]).not.toHaveBeenCalled();
  });

  it("Cmd+K then Cmd+Shift+Enter fires tab.pinToggle", () => {
    const spies = setupCommandSpies();
    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    const second = makeEvent("Enter", { metaKey: true, shiftKey: true, code: "Enter" });
    handleGlobalKeyDown(second as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabPinToggle]).toHaveBeenCalledTimes(1);
  });

  it("Escape during pending cancels the chord without firing", () => {
    const spies = setupCommandSpies();
    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    const esc = makeEvent("Escape", { code: "Escape" });
    handleGlobalKeyDown(esc as unknown as KeyboardEvent);
    expect(esc.defaultPrevented).toBe(true);
    for (const id of Object.values(COMMANDS)) {
      expect(spies[id]).not.toHaveBeenCalled();
    }

    // After cancel, a fresh ⌘W resolves to tab.close (not tab.closeAll).
    const after = makeEvent("w", { metaKey: true, code: "KeyW" });
    handleGlobalKeyDown(after as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabClose]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.tabCloseAll]).not.toHaveBeenCalled();
  });

  it("a non-chord key after the leader is swallowed and clears pending", () => {
    const spies = setupCommandSpies();
    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    // Random "a" — no chord exists for it. Should swallow + clear.
    const stray = makeEvent("a", { code: "KeyA" });
    handleGlobalKeyDown(stray as unknown as KeyboardEvent);
    expect(stray.defaultPrevented).toBe(true);
    for (const id of Object.values(COMMANDS)) {
      expect(spies[id]).not.toHaveBeenCalled();
    }

    // Pending cleared — fresh ⌘W resolves normally.
    const after = makeEvent("w", { metaKey: true, code: "KeyW" });
    handleGlobalKeyDown(after as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabClose]).toHaveBeenCalledTimes(1);
  });

  it("expired pending state lets the next key route normally", () => {
    const spies = setupCommandSpies();
    let now = 1_000_000;
    __setChordClockForTests(() => now);

    handleGlobalKeyDown(
      makeEvent("k", { metaKey: true, code: "KeyK" }) as unknown as KeyboardEvent,
    );
    // Advance past the chord timeout (1500ms).
    now += 2000;

    const second = makeEvent("u", { code: "KeyU" });
    handleGlobalKeyDown(second as unknown as KeyboardEvent);

    // No chord fires (pending expired); plain "u" matches no single
    // binding either, so nothing happens at all.
    for (const id of Object.values(COMMANDS)) {
      expect(spies[id]).not.toHaveBeenCalled();
    }
  });

  it("Cmd+K is suppressed when focus is inside an editable", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const leader = makeEvent("k", { metaKey: true, code: "KeyK", target });
    handleGlobalKeyDown(leader as unknown as KeyboardEvent);
    expect(leader.defaultPrevented).toBe(false);

    // Pending wasn't entered — the next ⌘W should fire tab.close.
    const next = makeEvent("w", { metaKey: true, code: "KeyW" });
    handleGlobalKeyDown(next as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabClose]).toHaveBeenCalledTimes(1);
  });
});
