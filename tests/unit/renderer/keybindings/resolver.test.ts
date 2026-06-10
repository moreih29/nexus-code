import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetContextProbesForTests,
  registerContextProbe,
} from "../../../../src/renderer/keybindings/context-keys";
import {
  __resetActiveBindingsForTests,
  resolveEvent,
  setActiveBindings,
} from "../../../../src/renderer/keybindings/resolver";
import { ALL_COMMAND_IDS, COMMANDS } from "../../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../../src/shared/keybindings/index";
import { applyKeybindingOverrides } from "../../../../src/shared/keybindings/overrides";

interface MockKE {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
  key: string;
}
function ev(code: string, mods: Partial<Omit<MockKE, "code" | "key">> = {}, key = ""): MockKE {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    code,
    key,
    ...mods,
  };
}

describe("resolveEvent — no chord pending", () => {
  it("returns single-match for ⌘W", () => {
    const r = resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, null);
    expect(r.kind).toBe("single");
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabClose);
  });

  it("returns chord-leader for ⌘K", () => {
    const r = resolveEvent(ev("KeyK", { metaKey: true }) as unknown as KeyboardEvent, null);
    expect(r.kind).toBe("chord-leader");
    if (r.kind !== "chord-leader") throw new Error("unreachable");
    expect(r.leaderId).toBe("CmdOrCtrl+K");
  });

  it("returns none for an unbound key", () => {
    const r = resolveEvent(ev("KeyJ", { metaKey: true }) as unknown as KeyboardEvent, null);
    expect(r.kind).toBe("none");
  });

  it("matches files.refresh on ⌘R outside browser tabs / Win-Linux terminals", () => {
    // `when: "!browserTabActive && (!terminalFocus || isMac)"` — with no
    // browser tab active and no terminal focus both guards pass, so ⌘R
    // still refreshes files from any ordinary focus context.
    const r = resolveEvent(ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent, null);
    expect(r.kind).toBe("single");
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.filesRefresh);
  });

  it("matches ⌘\\ only on the Backslash code — ⌘/ must pass through to Monaco", () => {
    expect(
      resolveEvent(ev("Backslash", { metaKey: true }) as unknown as KeyboardEvent, null).kind,
    ).toBe("single");
    // Regression guard: ⌘/ (Slash) is Monaco's comment toggle; resolving it
    // here would swallow the event at capture phase.
    expect(
      resolveEvent(ev("Slash", { metaKey: true }) as unknown as KeyboardEvent, null).kind,
    ).toBe("none");
  });
});

describe("resolveEvent — when scoping", () => {
  function withTarget(
    code: string,
    mods: Partial<Omit<MockKE, "code" | "key">>,
    matches: string[],
  ): KeyboardEvent {
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: (sel: string) => (matches.includes(sel) ? ({} as HTMLElement) : null),
    };
    return { ...ev(code, mods), target } as unknown as KeyboardEvent;
  }

  it("⌘↵ matches openToSide inside the file tree (fileTreeFocus = true)", () => {
    const e = withTarget("Enter", { metaKey: true }, ['[role="tree"]']);
    const r = resolveEvent(e, null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.openToSide);
  });

  it("⌘↵ does not match outside the file tree (fileTreeFocus = false)", () => {
    const e = withTarget("Enter", { metaKey: true }, []);
    expect(resolveEvent(e, null).kind).toBe("none");
  });
});

describe("resolveEvent — runtime recompilation (user overrides)", () => {
  const KNOWN = new Set<string>(ALL_COMMAND_IDS);
  afterEach(() => {
    __resetActiveBindingsForTests();
  });

  it("a rebound command matches the new key and releases the old one", () => {
    setActiveBindings(
      applyKeybindingOverrides(
        KEYBINDINGS,
        [{ command: COMMANDS.tabClose, primary: "CmdOrCtrl+Shift+X" }],
        KNOWN,
      ),
    );
    // old key released…
    expect(resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, null).kind).toBe(
      "none",
    );
    // …new key live, same command.
    const r = resolveEvent(
      ev("KeyX", { metaKey: true, shiftKey: true }) as unknown as KeyboardEvent,
      null,
    );
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.tabClose);
  });

  it("an unbound command (primary: null) stops matching entirely", () => {
    setActiveBindings(
      applyKeybindingOverrides(KEYBINDINGS, [{ command: COMMANDS.tabClose, primary: null }], KNOWN),
    );
    expect(resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, null).kind).toBe(
      "none",
    );
  });

  it("reset restores the default table", () => {
    setActiveBindings(
      applyKeybindingOverrides(KEYBINDINGS, [{ command: COMMANDS.tabClose, primary: null }], KNOWN),
    );
    __resetActiveBindingsForTests();
    const r = resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.tabClose);
  });
});

describe("resolveEvent — browserTabActive state probe", () => {
  afterEach(() => {
    __resetContextProbesForTests();
  });

  it("routes ⌘R to browser.reload when the active tab is a browser tab", () => {
    registerContextProbe("browserTabActive", () => true);
    const r = resolveEvent(ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent, null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.browserReload);
  });

  it("routes ⌘⇧R to browser.hardReload when the active tab is a browser tab", () => {
    registerContextProbe("browserTabActive", () => true);
    const r = resolveEvent(
      ev("KeyR", { metaKey: true, shiftKey: true }) as unknown as KeyboardEvent,
      null,
    );
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.browserHardReload);
  });

  it("keeps ⌘R on files.refresh when the probe reports no browser tab", () => {
    registerContextProbe("browserTabActive", () => false);
    const r = resolveEvent(ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent, null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.filesRefresh);
  });

  it("matches ⌘L / ⌘[ / ⌘] only while a browser tab is active", () => {
    // Without the probe (or with it false) these must resolve to none —
    // ⌘L etc. are not global app shortcuts.
    expect(resolveEvent(ev("KeyL", { metaKey: true }) as unknown as KeyboardEvent, null).kind).toBe(
      "none",
    );
    registerContextProbe("browserTabActive", () => true);
    const focusUrl = resolveEvent(ev("KeyL", { metaKey: true }) as unknown as KeyboardEvent, null);
    if (focusUrl.kind !== "single") throw new Error("expected single match");
    expect(focusUrl.command).toBe(COMMANDS.browserFocusUrl);
    const back = resolveEvent(
      ev("BracketLeft", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    if (back.kind !== "single") throw new Error("expected single match");
    expect(back.command).toBe(COMMANDS.browserGoBack);
    const fwd = resolveEvent(
      ev("BracketRight", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    if (fwd.kind !== "single") throw new Error("expected single match");
    expect(fwd.command).toBe(COMMANDS.browserGoForward);
  });

  it("⌘⌥I is not in the table (owned by the Electron menu DevTools role)", () => {
    registerContextProbe("browserTabActive", () => true);
    const devtools = resolveEvent(
      ev("KeyI", { metaKey: true, altKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(devtools.kind).toBe("none");
  });
});

describe("resolveEvent — terminal shell-key guard (Mac)", () => {
  // On Mac (`isMac` true) the `!terminalFocus || isMac` guard is always
  // satisfied — ⌘-letter shortcuts keep firing inside the terminal. The
  // Win/Linux half (Ctrl+R etc. yielding to the shell) cannot be
  // exercised here because the resolver's IS_MAC is fixed at module
  // load; the guard expression itself is covered by keybinding-when
  // tests.
  function terminalTarget(code: string, mods: Partial<Omit<MockKE, "code" | "key">>) {
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: (sel: string) => (sel === ".xterm" ? ({} as HTMLElement) : null),
    };
    return { ...ev(code, mods), target } as unknown as KeyboardEvent;
  }

  it("⌘R inside the terminal still refreshes files on Mac", () => {
    const r = resolveEvent(terminalTarget("KeyR", { metaKey: true }), null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.filesRefresh);
  });

  it("⌘W inside the terminal still closes the tab on Mac", () => {
    const r = resolveEvent(terminalTarget("KeyW", { metaKey: true }), null);
    if (r.kind !== "single") throw new Error("expected single match");
    expect(r.command).toBe(COMMANDS.tabClose);
  });

  it("⌘K inside the terminal still arms the chord leader on Mac", () => {
    const r = resolveEvent(terminalTarget("KeyK", { metaKey: true }), null);
    expect(r.kind).toBe("chord-leader");
  });
});

describe("resolveEvent — chord pending", () => {
  const PENDING = "CmdOrCtrl+K";

  it("returns chord-completed for ⌘W during pending", () => {
    const r = resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, PENDING);
    expect(r.kind).toBe("chord-completed");
    if (r.kind !== "chord-completed") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabCloseAll);
  });

  it("returns chord-completed for plain U during pending", () => {
    const r = resolveEvent(ev("KeyU") as unknown as KeyboardEvent, PENDING);
    if (r.kind !== "chord-completed") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabCloseSaved);
  });

  it("returns chord-completed for ⌘U when leader required ⌘ (strict-superset of VSCode)", () => {
    // The user kept ⌘ held through ⌘K → ⌘U. VSCode's exact matcher
    // would treat this as a miss; we mask the leader-only modifier
    // so the chord still completes.
    const r = resolveEvent(ev("KeyU", { metaKey: true }) as unknown as KeyboardEvent, PENDING);
    if (r.kind !== "chord-completed") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabCloseSaved);
  });

  it("returns chord-completed for ⌘⇧Enter during pending", () => {
    const r = resolveEvent(
      ev("Enter", { metaKey: true, shiftKey: true }) as unknown as KeyboardEvent,
      PENDING,
    );
    if (r.kind !== "chord-completed") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabPinToggle);
  });

  it("returns chord-mismatch for an unbound second key", () => {
    const r = resolveEvent(ev("KeyJ") as unknown as KeyboardEvent, PENDING);
    expect(r.kind).toBe("chord-mismatch");
  });

  it("does not return single-match for primaries while a chord is pending", () => {
    // ⌘R alone is normally files.refresh, but during ⌘K pending it
    // should be chord-mismatch (no chord secondary for ⌘R under ⌘K).
    const r = resolveEvent(ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent, PENDING);
    expect(r.kind).toBe("chord-mismatch");
  });
});
