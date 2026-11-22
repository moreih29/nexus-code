import { describe, expect, mock, test } from "bun:test";
import { listenForPaneActivation } from "../../../../src/renderer/utils/pane-activation";

function fixture() {
  const window = new EventTarget();
  const doc = { defaultView: window, activeElement: null as { tagName: string } | null };
  const addEventListener = mock((_name: string, _fn: () => void, _capture?: boolean) => {});
  const removeEventListener = mock((_name: string, _fn: () => void, _capture?: boolean) => {});
  const pane = {
    ownerDocument: doc,
    contains: () => false,
    addEventListener,
    removeEventListener,
  } as unknown as HTMLElement;
  const activate = mock(() => {});
  const cleanup = listenForPaneActivation(pane, activate);
  return { addEventListener, removeEventListener, activate, cleanup };
}

describe("listenForPaneActivation", () => {
  test("captures pointerdown before child handlers and keeps keyboard focus activation", () => {
    const { addEventListener, activate, cleanup } = fixture();
    expect(addEventListener.mock.calls).toEqual([
      ["focusin", activate],
      ["pointerdown", activate, true],
    ]);
    cleanup();
  });

  test("removes the captured listener when the pane unmounts", () => {
    const { removeEventListener, activate, cleanup } = fixture();
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("pointerdown", activate, true);
  });
});
