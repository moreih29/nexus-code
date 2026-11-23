import { useEffect } from "react";
import { create } from "zustand";
import { ipcCallResult } from "@/ipc/client";

export interface BrowserSuspendClaimOptions {
  captureSnapshot?: boolean;
}

interface BrowserSuspendState {
  count: number;
  claim(opts?: BrowserSuspendClaimOptions): () => void;
}

export const useBrowserSuspendStore = create<BrowserSuspendState>((set, get) => ({
  count: 0,
  claim(opts) {
    const captureSnapshot = opts?.captureSnapshot ?? true;
    const next = get().count + 1;
    set({ count: next });
    if (next === 1) {
      void ipcCallResult("browser", "suspendAll", { captureSnapshot });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const after = get().count - 1;
      set({ count: Math.max(0, after) });
      if (after <= 0) {
        void ipcCallResult("browser", "resumeAll", {});
      }
    };
  },
}));

export function useBrowserSuspendWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const release = useBrowserSuspendStore.getState().claim();
    return release;
  }, [active]);
}
