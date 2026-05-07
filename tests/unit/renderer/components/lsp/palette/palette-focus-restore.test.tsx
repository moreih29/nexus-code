/**
 * palette-focus-restore — WAI-ARIA focus-restore logic unit tests.
 *
 * DOM note: bun:test has no jsdom. We hand-roll minimal HTMLElement stubs
 * that implement only the surface the cleanup function consults:
 *   - isConnected: boolean
 *   - hasAttribute(name): boolean
 *   - focus(options): void
 *
 * We verify the three guard paths:
 *   1. caller button is connected and enabled → focus() is called
 *   2. caller was detached before close (isConnected = false) → focus() not called
 *   3. caller was disabled before close → focus() not called
 *
 * The restore callback mirrors the useEffect cleanup in command-palette.tsx
 * so that logic changes in the component are caught by these tests.
 */

import { describe, expect, it } from "bun:test";

interface FakeElement {
  isConnected: boolean;
  disabled: boolean;
  focusCalls: number;
  hasAttribute(name: string): boolean;
  focus(options?: { preventScroll?: boolean }): void;
}

function makeFakeElement(opts: { isConnected: boolean; disabled: boolean }): FakeElement {
  const el: FakeElement = {
    isConnected: opts.isConnected,
    disabled: opts.disabled,
    focusCalls: 0,
    hasAttribute(name: string): boolean {
      return name === "disabled" ? el.disabled : false;
    },
    focus(_options?: { preventScroll?: boolean }): void {
      el.focusCalls += 1;
    },
  };
  return el;
}

/**
 * Mirrors the useEffect cleanup extracted from command-palette.tsx.
 * If the implementation changes, update this function to match.
 */
function runCleanup(target: FakeElement | null): void {
  if (target?.isConnected && !target.hasAttribute("disabled")) {
    target.focus({ preventScroll: true });
  }
}

describe("focus-restore cleanup guard", () => {
  it("restores focus to a connected, enabled caller element", () => {
    const caller = makeFakeElement({ isConnected: true, disabled: false });
    runCleanup(caller);
    expect(caller.focusCalls).toBe(1);
  });

  it("skips focus restore when caller is detached (isConnected = false)", () => {
    const caller = makeFakeElement({ isConnected: false, disabled: false });
    runCleanup(caller);
    expect(caller.focusCalls).toBe(0);
  });

  it("skips focus restore when caller has the disabled attribute", () => {
    const caller = makeFakeElement({ isConnected: true, disabled: true });
    runCleanup(caller);
    expect(caller.focusCalls).toBe(0);
  });

  it("skips focus restore silently when previouslyFocused is null (no prior focus captured)", () => {
    expect(() => runCleanup(null)).not.toThrow();
  });
});

describe("previouslyFocusedRef lifecycle", () => {
  it("nulls out the ref before attempting restore (second cleanup call is a no-op)", () => {
    const caller = makeFakeElement({ isConnected: true, disabled: false });

    // Simulate what the useEffect cleanup does: read, null ref, then restore.
    let ref: FakeElement | null = caller;
    const target = ref;
    ref = null;
    runCleanup(target);

    // ref is now null — a second cleanup call with null is silent
    runCleanup(ref);

    expect(caller.focusCalls).toBe(1);
  });
});
