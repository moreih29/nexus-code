import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetActiveBindingsForTests,
  resolveEvent,
  setActiveBindings,
} from "../../../../src/renderer/keybindings/resolver";
import { setPlatformForTests } from "../../../../src/renderer/utils/platform";
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

function terminalTarget(code: string, mods: Partial<Omit<MockKE, "code" | "key">>) {
  const target = {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === ".xterm" ? ({} as HTMLElement) : null),
  };
  return { ...ev(code, mods), target } as unknown as KeyboardEvent;
}

describe("resolveEvent — terminal shell-key guard (Win/Linux)", () => {
  // `CmdOrCtrl` is Ctrl here, and the Ctrl keys a shell uses go to the
  // terminal; the keys that also work there stand in for them.
  afterEach(() => setPlatformForTests(null));

  for (const platform of ["win32", "linux"] as const) {
    it(`leaves the shell's Ctrl keys to the terminal on ${platform}`, () => {
      setPlatformForTests(platform);
      for (const code of ["KeyR", "KeyW", "KeyT", "KeyK"]) {
        expect(resolveEvent(terminalTarget(code, { ctrlKey: true }), null).kind).toBe("none");
      }
      const refresh = resolveEvent(ev("KeyR", { ctrlKey: true }) as unknown as KeyboardEvent, null);
      expect(refresh).toEqual({ kind: "single", command: COMMANDS.filesRefresh });
    });

    it(`keeps Ctrl+Shift+T and Ctrl+F4 working in the terminal on ${platform}`, () => {
      setPlatformForTests(platform);
      expect(resolveEvent(terminalTarget("KeyT", { ctrlKey: true, shiftKey: true }), null)).toEqual(
        { kind: "single", command: COMMANDS.terminalNew },
      );
      expect(resolveEvent(terminalTarget("F4", { ctrlKey: true }), null)).toEqual({
        kind: "single",
        command: COMMANDS.tabClose,
      });
    });
  }

  it("does not take the Windows key for CmdOrCtrl", () => {
    setPlatformForTests("win32");
    const r = resolveEvent(ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent, null);
    expect(r.kind).toBe("none");
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
