import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("browser-permissions");

interface BrowserPermissionsState {
  grants: Record<string, boolean>;

  hydrate(grants: Record<string, boolean> | undefined): void;

  setGrant(permissionKeys: string[], enabled: boolean): void;
}

export const useBrowserPermissionsStore = create<BrowserPermissionsState>((set, get) => ({
  grants: {},

  hydrate(grants) {
    set({ grants: grants ?? {} });
  },

  setGrant(permissionKeys, enabled) {
    const current = get().grants;
    const next: Record<string, boolean> = { ...current };
    for (const key of permissionKeys) {
      next[key] = enabled;
    }
    set({ grants: next });
    void ipcCallResult("appState", "set", { browserPermissionGrants: next }).then((result) => {
      if (!result.ok) {
        log.warn(`appState set failed: ${result.message}`);
      }
    });
  },
}));
