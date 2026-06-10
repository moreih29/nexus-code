/**
 * Unit tests for the dispatcher (`src/renderer/keybindings/dispatcher.ts`).
 *
 * Resolver and chord-state are tested in their own files; this file
 * focuses on dispatcher orchestration: keystroke → command, chord
 * lifecycle (Escape, mismatch, expiry), and the boolean return that
 * drives the listener's `stopImmediatePropagation()` decision.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  __resetCommandsForTests,
  registerCommand,
} from "../../../../src/renderer/commands/registry";
import {
  __resetChordStateForTests,
  __setChordClockForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

interface MockEvent {
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  code: string;
  target: unknown;
  isComposing: boolean;
  keyCode: number;
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
    isComposing?: boolean;
    keyCode?: number;
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
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
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
// handleGlobalKeyDown — IME composition guard
// ---------------------------------------------------------------------------
//
// 한국어/일본어 IME가 helper textarea에서 합성 중일 때 단축키가 발화하면
// `preventDefault + stopImmediatePropagation`이 textarea의 composition state를
// 깨뜨려 한글 입력 중복·stuck 버그를 유발한다. 합성 중에는 어떤 키도 claim
// 하지 않고 그대로 흘려보내야 한다. `matchesEvent`가 `e.code`(물리 키)로
// 매칭하므로 한글 타자 중에도 `Cmd+R` 같은 단축키가 hit하는 게 핵심.

describe("handleGlobalKeyDown — IME composition guard", () => {
  it("does NOT claim Cmd+R when isComposing is true (would otherwise fire files.refresh)", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("Process", { metaKey: true, code: "KeyR", isComposing: true });
    const claimed = handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(claimed).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(spies[COMMANDS.filesRefresh]).not.toHaveBeenCalled();
  });

  it("does NOT claim Cmd+R when keyCode is 229 (legacy Chromium IME fallback)", () => {
    // 옛 Chromium에서 isComposing 플래그가 일부 keydown에 늦게 세팅되는
    // 케이스 — keyCode === 229만으로도 IME 합성 중임을 식별해야 한다.
    const spies = setupCommandSpies();
    const e = makeEvent("Process", { metaKey: true, code: "KeyR", keyCode: 229 });
    const claimed = handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(claimed).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(spies[COMMANDS.filesRefresh]).not.toHaveBeenCalled();
  });

  it("DOES claim Cmd+R after composition ends (isComposing false, keyCode normal)", () => {
    // 합성이 끝난 직후 사용자가 같은 키를 다시 눌렀을 때는 평소처럼 동작해야
    // 한다. 가드가 너무 넓게 잡지 않는지 확인하는 회귀 케이스.
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: true, code: "KeyR" });
    const claimed = handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(claimed).toBe(true);
    expect(spies[COMMANDS.filesRefresh]).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — file commands
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — refresh", () => {
  it("fires files.refresh on Cmd+R", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: true, code: "KeyR" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("still fires files.refresh inside an editable (matches the prior page-reload override)", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("r", { metaKey: true, code: "KeyR", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not fire on plain r without modifier", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("r", { metaKey: false, code: "KeyR" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.filesRefresh]).not.toHaveBeenCalled();
  });
});

describe("handleGlobalKeyDown — fileOpen fires regardless of focus", () => {
  // Phase 3: VSCode-default behaviour — application-level shortcuts
  // fire even from inside an INPUT / editor unless their declaration
  // explicitly scopes via `when`.
  it("fires file.open on Cmd+E even when target is INPUT", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("e", { metaKey: true, code: "KeyE", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.fileOpen]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("fires file.open on Cmd+E for a plain target", () => {
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

  it("fires file.open on Cmd+O", () => {
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
// handleGlobalKeyDown — split (Backslash only; ⌘/ belongs to Monaco)
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — split", () => {
  it("fires group.splitRight on Cmd+\\ (code=Backslash)", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("\\", { metaKey: true, code: "Backslash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does NOT fire split on Cmd+/ (code=Slash) — Monaco's comment toggle", () => {
    const spies = setupCommandSpies();
    const e = makeEvent("/", { metaKey: true, code: "Slash" });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
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

  it("fires split even when target is INPUT (no when scoping on split bindings)", () => {
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("\\", { metaKey: true, code: "Backslash", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.groupSplitRight]).toHaveBeenCalledTimes(1);
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

describe("handleGlobalKeyDown — when scoping (openToSide)", () => {
  it("Cmd+Enter fires openToSide when target is inside [role='tree']", () => {
    const spies = setupCommandSpies();
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
    } as unknown as HTMLElement;
    const e = makeEvent("Enter", { metaKey: true, code: "Enter", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.openToSide]).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+Enter does NOT fire openToSide outside the file tree", () => {
    const spies = setupCommandSpies();
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("Enter", { metaKey: true, code: "Enter", target });
    handleGlobalKeyDown(e as unknown as KeyboardEvent);
    expect(spies[COMMANDS.openToSide]).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
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

  it("Cmd+K enters pending even when focus is inside an editable (chord is intentional)", () => {
    // Phase 2 removed the editable guard from the chord pipeline:
    // ⌘K is never accidentally typed, so even from inside Monaco /
    // an input we treat it as the user beginning a chord.
    const spies = setupCommandSpies();
    const target = { tagName: "INPUT" } as HTMLElement;
    const leader = makeEvent("k", { metaKey: true, code: "KeyK", target });
    handleGlobalKeyDown(leader as unknown as KeyboardEvent);
    expect(leader.defaultPrevented).toBe(true);

    const next = makeEvent("w", { metaKey: true, code: "KeyW", target });
    handleGlobalKeyDown(next as unknown as KeyboardEvent);
    expect(spies[COMMANDS.tabCloseAll]).toHaveBeenCalledTimes(1);
    expect(spies[COMMANDS.tabClose]).not.toHaveBeenCalled();
  });
});
