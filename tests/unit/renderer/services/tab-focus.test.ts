/**
 * Tab-focus registry — focus lands in a tab's content once its view is
 * registered, on the next animation frame.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetTabFocusForTests,
  registerTabFocusTarget,
  requestTabFocus,
} from "../../../../src/renderer/services/tab-focus";

const frames: Array<() => void> = [];
const originalRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  frames.push(() => callback(0));
  return frames.length;
}) as typeof requestAnimationFrame;

afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
});

function runFrames(): void {
  for (const frame of frames.splice(0)) frame();
}

beforeEach(() => {
  __resetTabFocusForTests();
  frames.length = 0;
});

describe("requestTabFocus", () => {
  it("focuses a registered tab on the next frame", () => {
    const focused: string[] = [];
    registerTabFocusTarget("a", () => focused.push("a"));

    requestTabFocus("a");
    expect(focused).toEqual([]);
    runFrames();
    expect(focused).toEqual(["a"]);
  });

  it("focuses a tab whose view registers after the request", () => {
    const focused: string[] = [];
    requestTabFocus("a");
    runFrames();

    registerTabFocusTarget("a", () => focused.push("a"));
    runFrames();
    expect(focused).toEqual(["a"]);
  });

  it("drops a pending request once another tab is asked for", () => {
    const focused: string[] = [];
    requestTabFocus("a");
    registerTabFocusTarget("b", () => focused.push("b"));
    requestTabFocus("b");

    registerTabFocusTarget("a", () => focused.push("a"));
    runFrames();
    expect(focused).toEqual(["b"]);
  });

  it("does not focus a tab whose view has unregistered", () => {
    const focused: string[] = [];
    const unregister = registerTabFocusTarget("a", () => focused.push("a"));
    unregister();

    requestTabFocus("a");
    runFrames();
    expect(focused).toEqual([]);
  });

  it("keeps a newer registration when an older one unregisters", () => {
    const focused: string[] = [];
    const unregisterOld = registerTabFocusTarget("a", () => focused.push("old"));
    registerTabFocusTarget("a", () => focused.push("new"));
    unregisterOld();

    requestTabFocus("a");
    runFrames();
    expect(focused).toEqual(["new"]);
  });
});
