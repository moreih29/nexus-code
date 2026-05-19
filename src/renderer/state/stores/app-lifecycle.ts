// src/renderer/state/stores/app-lifecycle.ts — Application lifecycle store.
//
// Provides the `requestRestart` action, which coordinates pending IPC writes
// before triggering an app restart via the `app` IPC channel.
//
// CRITICAL risk mitigation (pending-write loss):
//   Stage 1 — the window-opacity store tracks its in-flight appState.set IPC
//              promise in `pendingWrite`.  `requestRestart` awaits it before
//              issuing the restart command so no pending write is lost.
//   Stage 2 — the main process calls `stateService.flushNow()` synchronously
//              before `app.relaunch` to guarantee disk durability even if a
//              write arrives in the brief window between the renderer await and
//              the process exit.

import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";
import { useWindowOpacityStore } from "./window-opacity";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface AppLifecycleState {
  /**
   * Request an app restart.
   *
   * Steps (pending-write serialization):
   *   1. Await the window-opacity store's pending appState.set IPC response,
   *      if any, so the main process has durably written the new opacity
   *      before the process exits.
   *   2. Call `app.restart({ reason })` via IPC, which flushes state on the
   *      main side and schedules `app.relaunch` + `app.exit(0)` via
   *      `setImmediate` (so the IPC reply envelope is delivered first).
   *
   * `reason` is a short diagnostic string logged by main (e.g. "opacity-change").
   */
  requestRestart(reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppLifecycleStore = create<AppLifecycleState>(() => ({
  async requestRestart(reason: string): Promise<void> {
    // --- Stage 1: drain pending writes ----------------------------------------
    // Await the window-opacity store's in-flight appState.set response before
    // triggering the restart.  This prevents the race where the main process
    // exits before the `setState` IPC write is acknowledged, which would lose
    // the last opacity change on disk.
    const pending = useWindowOpacityStore.getState().pendingWrite;
    if (pending !== null) {
      // Errors from the pending write are already logged by the window-opacity
      // store; we swallow them here so a failed write doesn't block the restart.
      await pending.catch(() => undefined);
    }

    // --- Stage 2: issue restart via IPC ----------------------------------------
    // The main handler flushes state (Stage 2 server-side mitigation) and
    // schedules relaunch via setImmediate so this response is delivered first.
    const result = await ipcCallResult("app", "restart", { reason });
    if (!result.ok) {
      // Log unexpected failure — the restart did not happen.
      console.warn("[app-lifecycle] restart IPC call failed", result.kind, result.message);
    }
  },
}));
