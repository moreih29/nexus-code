import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("window-opacity");

const WINDOW_OPACITY_STORAGE_KEY = "windowOpacity";

interface WindowOpacityState {
  opacity: number;

  hydrate(opacity: number | undefined): void;

  setOpacity(opacity: number, options?: { persist?: boolean }): void;
}

export const useWindowOpacityStore = create<WindowOpacityState>((set) => {
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(WINDOW_OPACITY_STORAGE_KEY) : null;
  const parsed = storedRaw !== null ? parseFloat(storedRaw) : Number.NaN;
  const initialOpacity = !Number.isNaN(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;

  return {
    opacity: initialOpacity,

    hydrate(opacity) {
      const value = opacity ?? 1;
      set({ opacity: value });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(value));
      }
    },

    setOpacity(opacity, options) {
      set({ opacity });
      if (options?.persist === false) return;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(opacity));
      }
      void ipcCallResult("appState", "set", {
        windowOpacity: opacity === 1 ? undefined : opacity,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },
  };
});
