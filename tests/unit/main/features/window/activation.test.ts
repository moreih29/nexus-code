/** Which input lets the app window open a link in the browser. */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  activates,
  USER_ACTIVATION_MS,
  UserActivation,
  watchActivation,
} from "../../../../../src/main/features/window/activation";

describe("input that lets a link open", () => {
  test("a click or a tap, and Enter or Space on a focused link", () => {
    expect(activates({ type: "mouseDown" })).toBe(true);
    expect(activates({ type: "mouseUp" })).toBe(true);
    expect(activates({ type: "touchEnd" })).toBe(true);
    expect(activates({ type: "gestureTap" })).toBe(true);
    expect(activates({ type: "keyDown", key: "Enter" })).toBe(true);
    expect(activates({ type: "rawKeyDown", key: " " })).toBe(true);
    expect(activates({ type: "keyDown", key: "Enter", isAutoRepeat: false })).toBe(true);
    expect(activates({ type: "rawKeyDown", key: "Enter", modifiers: ["shift", "numlock"] })).toBe(
      true,
    );
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

  test("not a modifier alone", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      expect(activates({ type: "keyDown", key })).toBe(false);
      expect(activates({ type: "rawKeyDown", key })).toBe(false);
    }
  });

  test("not Enter or Space held down, as each source tells it", () => {
    // before-input-event
    expect(activates({ type: "keyDown", key: "Enter", isAutoRepeat: true })).toBe(false);
    expect(
      activates({ type: "keyDown", key: " ", isAutoRepeat: true, modifiers: ["isautorepeat"] }),
    ).toBe(false);
    // input-event
    expect(
      activates({ type: "rawKeyDown", key: "Enter", modifiers: ["isautorepeat", "numlock"] }),
    ).toBe(false);
    expect(activates({ type: "rawKeyDown", key: " ", modifiers: ["isAutoRepeat"] })).toBe(false);
  });

  test("for a moment only", () => {
    expect(USER_ACTIVATION_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("the window's activation", () => {
  function setup() {
    let now = 10_000;
    const contents = new EventEmitter();
    const activation = new UserActivation(() => now);
    watchActivation(contents, activation);
    return {
      contents,
      activation,
      wait: (ms: number) => {
        now += ms;
      },
    };
  }

  test("lets one window.open through after an input, at once", () => {
    const { contents, activation, wait } = setup();
    expect(activation.take()).toBe(false);
    contents.emit("before-mouse-event", {}, { type: "mouseDown", x: 3, y: 4 });
    wait(USER_ACTIVATION_MS);
    expect(activation.take()).toBe(true);
    expect(activation.take()).toBe(false);
  });

  test("not once the moment has passed", () => {
    const { contents, activation, wait } = setup();
    contents.emit("before-input-event", {}, { type: "keyDown", key: "Enter" });
    wait(USER_ACTIVATION_MS + 1);
    expect(activation.take()).toBe(false);
  });

  test("takes keys and the mouse from every frame, a tap from input-event", () => {
    const { contents, activation } = setup();
    contents.emit("before-input-event", {}, { type: "keyDown", key: " " });
    expect(activation.take()).toBe(true);
    contents.emit("before-mouse-event", {}, { type: "mouseUp" });
    expect(activation.take()).toBe(true);
    contents.emit("input-event", {}, { type: "gestureTap" });
    expect(activation.take()).toBe(true);
    contents.emit("input-event", {}, { type: "touchEnd" });
    expect(activation.take()).toBe(true);
  });

  test("not typing, a key held down, the mouse moving, or input-event's keys and clicks", () => {
    const { contents, activation } = setup();
    contents.emit("before-input-event", {}, { type: "keyDown", key: "a" });
    contents.emit("before-input-event", {}, { type: "keyDown", key: "Shift" });
    contents.emit("before-input-event", {}, { type: "keyDown", key: "Enter", isAutoRepeat: true });
    contents.emit("before-mouse-event", {}, { type: "mouseMove" });
    // before-input-event and before-mouse-event give these, once.
    contents.emit("input-event", {}, { type: "rawKeyDown", key: "Enter" });
    contents.emit("input-event", {}, { type: "mouseDown" });
    expect(activation.take()).toBe(false);
  });
});
