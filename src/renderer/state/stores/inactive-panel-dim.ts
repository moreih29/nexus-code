import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("inactive-panel-dim");

const INACTIVE_PANEL_DIM_STORAGE_KEY = "inactivePanelDim";

export const INACTIVE_PANEL_DIM_DEFAULT = 1;
export const INACTIVE_PANEL_DIM_MIN = 0;
export const INACTIVE_PANEL_DIM_MAX = 2;

interface InactivePanelDimState {
  dim: number;

  hydrate(dim: number | undefined): void;

  setDim(dim: number, options?: { persist?: boolean }): void;
}

export const useInactivePanelDimStore = create<InactivePanelDimState>((set) => {
  const storedRaw =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(INACTIVE_PANEL_DIM_STORAGE_KEY)
      : null;
  const parsed = storedRaw !== null ? parseFloat(storedRaw) : Number.NaN;
  const initialDim =
    !Number.isNaN(parsed) && parsed >= INACTIVE_PANEL_DIM_MIN && parsed <= INACTIVE_PANEL_DIM_MAX
      ? parsed
      : INACTIVE_PANEL_DIM_DEFAULT;

  return {
    dim: initialDim,

    hydrate(dim) {
      const value = dim ?? INACTIVE_PANEL_DIM_DEFAULT;
      set({ dim: value });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(INACTIVE_PANEL_DIM_STORAGE_KEY, String(value));
      }
    },

    setDim(dim, options) {
      set({ dim });
      if (options?.persist === false) return;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(INACTIVE_PANEL_DIM_STORAGE_KEY, String(dim));
      }
      void ipcCallResult("appState", "set", {
        inactivePanelDim: dim === INACTIVE_PANEL_DIM_DEFAULT ? undefined : dim,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },
  };
});
