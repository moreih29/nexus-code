/**
 * Whether the app window is in front of the user: focused and not
 * minimized, as main's hook handler counts it before it leaves out a
 * notification. The active terminal is looked at only while it is; in
 * another app, the user doesn't see what finishes there.
 */

import { create } from "zustand";

interface AppFocusStore {
  focused: boolean;
}

function readFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus() && document.visibilityState !== "hidden";
}

export const useAppFocusStore = create<AppFocusStore>(() => ({ focused: readFocused() }));

/** Keeps the store current from the window's focus. Returns the stop function. */
export function startAppFocusTracking(): () => void {
  const update = (): void => {
    const focused = readFocused();
    if (useAppFocusStore.getState().focused !== focused) useAppFocusStore.setState({ focused });
  };
  // Focus moving into one of our own iframes (the HTML preview) blurs the
  // window while the document keeps focus; hasFocus() settles after the
  // event, hence the task hop.
  const onBlur = (): void => {
    setTimeout(update, 0);
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", update);
  update();
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", update);
  };
}
