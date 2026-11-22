import { describe, expect, mock, test } from "bun:test";
import {
  listenForPaneActivation,
  PANE_FRAME_FOCUS_EVENT,
} from "../../../../src/renderer/utils/pane-activation";

function fixture() {
  const window = new EventTarget();
  const doc = {
    defaultView: window,
    activeElement: null as EventTarget | null,
    hasFocus: mock(() => true),
  };
  const addEventListener = mock((_name: string, _fn: EventListener, _capture?: boolean) => {});
  const removeEventListener = mock((_name: string, _fn: EventListener, _capture?: boolean) => {});
  const pane = {
    ownerDocument: doc,
    contains: () => false,
    addEventListener,
    removeEventListener,
  } as unknown as HTMLElement;
  const activate = mock(() => {});
  const cleanup = listenForPaneActivation(pane, activate);
  const connectFrame = () => {
    const frame = new EventTarget();
    const registration = addEventListener.mock.calls.find(
      ([name]) => name === PANE_FRAME_FOCUS_EVENT,
    );
    if (!registration) throw new Error("Missing preview focus listener");
    frame.addEventListener(PANE_FRAME_FOCUS_EVENT, registration[1]);
    return frame;
  };
  return { doc, addEventListener, removeEventListener, activate, cleanup, connectFrame };
}

describe("listenForPaneActivation", () => {
  test("captures pointerdown before child handlers and keeps keyboard focus activation", () => {
    const { addEventListener, activate, cleanup } = fixture();
    expect(addEventListener).toHaveBeenCalledWith("focusin", activate);
    expect(addEventListener).toHaveBeenCalledWith("pointerdown", activate, true);
    cleanup();
  });

  test("removes the captured listener when the pane unmounts", () => {
    const { removeEventListener, activate, cleanup } = fixture();
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("pointerdown", activate, true);
  });

  test("activates for the focused preview frame without a window blur", () => {
    const { doc, activate, cleanup, connectFrame } = fixture();
    const frame = connectFrame();
    doc.activeElement = frame;

    frame.dispatchEvent(new Event(PANE_FRAME_FOCUS_EVENT));

    expect(activate).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("ignores a preview notification after focus leaves the frame or document", () => {
    const { doc, activate, cleanup, connectFrame } = fixture();
    const frame = connectFrame();

    doc.activeElement = new EventTarget();
    frame.dispatchEvent(new Event(PANE_FRAME_FOCUS_EVENT));
    doc.activeElement = frame;
    doc.hasFocus.mockReturnValue(false);
    frame.dispatchEvent(new Event(PANE_FRAME_FOCUS_EVENT));

    expect(activate).not.toHaveBeenCalled();
    cleanup();
  });
});
