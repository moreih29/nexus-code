// src/renderer/state/stores/browser-permissions.ts — Browser permission global toggle store.
//
// Mirrors the AppState `browserPermissionGrants` record in the renderer so the
// BrowserPermissionsPanel can read and optimistically update toggles without
// prop drilling through App.tsx.
//
// A single toggle may cover multiple BrowserPermissionKind values (e.g.
// 'midi+midiSysex' covers both 'midi' and 'midiSysex'). setGrant therefore
// accepts the full permissions array from PERMISSION_TOGGLES[].permissions and
// updates every key in the record atomically.
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store.
//   - No localStorage boot cache — this setting has no visual-before-React
//     dependency (contrast with theme), so a localStorage round-trip is
//     unnecessary complexity.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.

import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface BrowserPermissionsState {
  /**
   * Map from BrowserPermissionKind string to boolean.
   * Absent key or false = permission is OFF (denied globally).
   * Defaults to empty object until hydrated.
   */
  grants: Record<string, boolean>;

  /** Hydrate from persisted appState on bootstrap. */
  hydrate(grants: Record<string, boolean> | undefined): void;

  /**
   * Toggle one logical permission group on or off.
   * `permissionKeys` is PERMISSION_TOGGLES[].permissions — every key in the
   * array is set to `enabled` simultaneously so grouped toggles (e.g.
   * midi+midiSysex) stay in sync.
   *
   * Optimistic: local state is updated immediately; IPC persists asynchronously.
   */
  setGrant(permissionKeys: string[], enabled: boolean): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBrowserPermissionsStore = create<BrowserPermissionsState>((set, get) => ({
  grants: {},

  hydrate(grants) {
    set({ grants: grants ?? {} });
  },

  setGrant(permissionKeys, enabled) {
    // Build the updated record by merging the new values into the current state.
    const current = get().grants;
    const next: Record<string, boolean> = { ...current };
    for (const key of permissionKeys) {
      next[key] = enabled;
    }
    // Optimistic local update.
    set({ grants: next });
    // Persist to appState — fire-and-forget; boot state is authoritative.
    void ipcCallResult("appState", "set", { browserPermissionGrants: next }).then((result) => {
      if (!result.ok) {
        console.warn("[browser-permissions] appState set failed", result.message);
      }
    });
  },
}));
