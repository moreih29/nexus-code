/** Which input lets the app window open a link in the browser. */
import { describe, expect, test } from "bun:test";
import { activates, USER_ACTIVATION_MS } from "../../../../../src/main/features/window/activation";

describe("input that lets a link open", () => {
  test("a click or a tap, and Enter or Space on a focused link", () => {
    expect(activates({ type: "mouseDown" })).toBe(true);
    expect(activates({ type: "mouseUp" })).toBe(true);
    expect(activates({ type: "touchEnd" })).toBe(true);
    expect(activates({ type: "gestureTap" })).toBe(true);
    expect(activates({ type: "keyDown", key: "Enter" })).toBe(true);
    expect(activates({ type: "rawKeyDown", key: " " })).toBe(true);
  });

  test("not keys typed into the editor, nor the mouse moving, nor a key let go", () => {
    for (const key of ["a", "ㅎ", "Backspace", "Tab", "ArrowUp", "Process"]) {
      expect(activates({ type: "keyDown", key })).toBe(false);
      expect(activates({ type: "rawKeyDown", key })).toBe(false);
    }
    expect(activates({ type: "keyDown" })).toBe(false);
    expect(activates({ type: "mouseMove" })).toBe(false);
    expect(activates({ type: "keyUp", key: "Enter" })).toBe(false);
  });

  test("for a moment only", () => {
    expect(USER_ACTIVATION_MS).toBeLessThanOrEqual(1_000);
  });
});
