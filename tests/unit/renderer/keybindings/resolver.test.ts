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

  it("respects guardEditable: false on files.refresh", () => {
    const r = resolveEvent(
      ev("KeyR", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    expect(r.kind).toBe("single");
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.command).toBe(COMMANDS.filesRefresh);
    expect(r.respectGuardEditable).toBe(false);
  });

  it("respects guardEditable: true (default) on tabClose", () => {
    const r = resolveEvent(
      ev("KeyW", { metaKey: true }) as unknown as KeyboardEvent,
      null,
    );
    if (r.kind !== "single") throw new Error("unreachable");
    expect(r.respectGuardEditable).toBe(true);
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
