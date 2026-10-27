/**
 * Popups opened from a workspace's browser tabs must close with the
 * workspace and with the main window. Regression: nothing tracked them, so
 * they survived workspace removal (after its partition storage was wiped)
 * and main-window close.
 */
import { describe, expect, mock, test } from "bun:test";
import { PopupTracker } from "../../../../../src/main/features/browser/popup-tracker";

function makePopup() {
  const handlers = new Map<string, Array<() => void>>();
  const popup = {
    destroyed: false,
    isDestroyed: () => popup.destroyed,
    destroy: mock(() => {
      popup.destroyed = true;
      for (const handler of handlers.get("closed") ?? []) handler();
    }),
    once: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  return popup;
}

describe("PopupTracker", () => {
  test("closeWorkspace closes only that workspace's popups", () => {
    const tracker = new PopupTracker();
    const a1 = makePopup();
    const a2 = makePopup();
    const b1 = makePopup();
    tracker.track("ws-a", a1 as never);
    tracker.track("ws-a", a2 as never);
    tracker.track("ws-b", b1 as never);

    tracker.closeWorkspace("ws-a");

    expect(a1.destroy).toHaveBeenCalledTimes(1);
    expect(a2.destroy).toHaveBeenCalledTimes(1);
    expect(b1.destroy).not.toHaveBeenCalled();
  });

  test("closeAll closes every popup, skipping ones the user already closed", () => {
    const tracker = new PopupTracker();
    const open = makePopup();
    const closed = makePopup();
    tracker.track("ws-a", open as never);
    tracker.track("ws-b", closed as never);
    closed.destroy();
    closed.destroy.mockClear();

    tracker.closeAll();

    expect(open.destroy).toHaveBeenCalledTimes(1);
    expect(closed.destroy).not.toHaveBeenCalled();
  });
});
