import { describe, expect, test } from "bun:test";
import {
  getActiveAppWindow,
  getFocusedAppWindow,
  hasAppWindow,
  trackAppWindow,
} from "../../../../../src/main/features/window/app-windows";

function makeWindow() {
  const handlers = new Map<string, Array<() => void>>();
  const add = (event: string, handler: () => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  };
  const win = {
    focused: false,
    destroyed: false,
    on: add,
    once: add,
    isFocused: () => win.focused,
    isDestroyed: () => win.destroyed,
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
  return win;
}

// Regression: menu commands and notification clicks used
// BrowserWindow.getFocusedWindow() ?? getAllWindows()[0], which picks a
// browser-tab popup when it has focus or was opened first.
describe("app windows", () => {
  test("acts on the focused app window, else the one focused last, never a popup", () => {
    const first = makeWindow();
    const second = makeWindow();
    trackAppWindow(first as never);
    trackAppWindow(second as never);

    first.focused = true;
    first.emit("focus");
    expect(getFocusedAppWindow()).toBe(first as never);
    expect(getActiveAppWindow()).toBe(first as never);

    // A popup takes focus: no app window is focused, the last one stays active.
    first.focused = false;
    expect(getFocusedAppWindow()).toBeNull();
    expect(getActiveAppWindow()).toBe(first as never);

    first.destroyed = true;
    first.emit("closed");
    expect(getActiveAppWindow()).toBe(second as never);

    second.destroyed = true;
    second.emit("closed");
    expect(getActiveAppWindow()).toBeNull();
    expect(hasAppWindow()).toBe(false);
  });
});
