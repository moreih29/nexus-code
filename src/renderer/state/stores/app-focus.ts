import { create } from "zustand";

interface AppFocusStore {
  focused: boolean;
}

function readFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus() && document.visibilityState !== "hidden";
}

export const useAppFocusStore = create<AppFocusStore>(() => ({ focused: readFocused() }));

export function startAppFocusTracking(): () => void {
  const update = (): void => {
    const focused = readFocused();
    if (useAppFocusStore.getState().focused !== focused) useAppFocusStore.setState({ focused });
  };
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
