import { describe, expect, it } from "bun:test";
import { COMMANDS } from "../../../../src/shared/commands";
import { resolveEvent } from "../../../../src/renderer/keybindings/resolver";

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
    const r = resolveEvent(
      ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(r.kind).toBe("single");
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.tabClose);
  });

  it("returns chord-leader for ⌘K", () => {
    const r = resolveEvent(
      ev("KeyK", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(r.kind).toBe("chord-leader");
    if (r.kind !== "chord-leader") throw new Error("unreachable");
    expect(r.leaderId).toBe("CmdOrCtrl+K");
  });

  it("returns none for an unbound key", () => {
    const r = resolveEvent(
      ev("KeyJ", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(r.kind).toBe("none");
  });

  it("matches files.refresh on ⌘R regardless of focus (no when)", () => {
    const r = resolveEvent(
      ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(r.kind).toBe("single");
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.filesRefresh);
  });

  it("matches ⌘\\ on both Backslash and Slash codes (Korean keyboard parity)", () => {
    expect(
      resolveEvent(
        ev("Backslash", { metaKey: true }) as unknown as KeyboardEvent,
        null,
      ).kind,
    ).toBe("single");
    expect(
      resolveEvent(ev("Slash", { metaKey: true }) as unknown as KeyboardEvent, null).kind,
    ).toBe("single");
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

describe("resolveEvent — chord pending", () => {
  const PENDING = "CmdOrCtrl+K";

  it("returns chord-completed for ⌘W during pending", () => {
    const r = resolveEvent(
      ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent,
      PENDING,
    );
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
    const r = resolveEvent(
      ev("KeyU", { metaKey: true }) as unknown as KeyboardEvent,
      PENDING,
    );
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
    const r = resolveEvent(
      ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent,
      PENDING,
    );
    expect(r.kind).toBe("chord-mismatch");
  });
});
