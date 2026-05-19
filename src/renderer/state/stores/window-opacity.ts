// src/renderer/state/stores/window-opacity.ts — Window opacity preference store.
//
// Mirrors the pattern established by state/stores/theme.ts.
//
// Persistence model (mirrors theme.ts decision):
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "windowOpacity" — boot cache, read synchronously by
//     the <head> inline script before first paint (FOUC prevention).
//
// Semantics: 0 = fully transparent, 1 = fully opaque (default).
// Mirrors Ghostty's background-opacity semantics.
// Changing this requires an app restart — `transparent` is constructor-only in Electron.
//
// `appliedOpacity` tracks the value that was active at the last boot-time
// hydration (i.e. the value currently in effect in the OS window).  It is
// set once during bootstrap and treated as immutable afterwards.
//
// `isDirty` derived selector: returns true when the user has changed the
// opacity since the last boot, meaning a restart is required to apply the
// pending change to the OS window.
//
// `pendingWrite` — the in-flight appState.set IPC promise, if any.
// Used by `useAppLifecycleStore.requestRestart` to serialize pending writes
// before triggering app.restart (CRITICAL risk mitigation for pending-write loss).

import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_OPACITY_STORAGE_KEY = "windowOpacity";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface WindowOpacityState {
  /** Currently configured opacity preference (may differ from the OS window). */
  opacity: number;

  /**
   * The opacity value that was in effect when the app last booted.
   * Set once during bootstrap hydration and never changed afterwards.
   * Used to detect whether a restart is needed to apply a pending change.
   */
  appliedOpacity: number;

  /**
   * In-flight appState.set IPC promise, or null when no write is pending.
   * Exposed so that `useAppLifecycleStore.requestRestart` can await it
   * before triggering a restart, preventing in-progress writes from being
   * lost when the main process exits.
   */
  pendingWrite: Promise<void> | null;

  /**
   * Returns true when `opacity !== appliedOpacity`, meaning the user has
   * changed the preference since the last boot and a restart is needed
   * before the OS window reflects the new value.
   *
   * Implemented as a store method (not a standalone selector) so callers can
   * subscribe to the same Zustand store without importing extra helpers.
   */
  isDirty(): boolean;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(opacity: number | undefined): void;

  /**
   * Set the window opacity preference.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   */
  setOpacity(opacity: number): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWindowOpacityStore = create<WindowOpacityState>((set, get) => {
  // Derive initial opacity from localStorage (written by boot script before
  // React loads). Falls back to 1 (fully opaque) if absent/invalid.
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(WINDOW_OPACITY_STORAGE_KEY) : null;
  const parsed = storedRaw !== null ? parseFloat(storedRaw) : Number.NaN;
  const initialOpacity = !Number.isNaN(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;

  return {
    opacity: initialOpacity,

    // appliedOpacity starts equal to initialOpacity (pre-hydration best guess
    // from localStorage).  It is overwritten with the authoritative value
    // during bootstrap hydration, after which it is immutable.
    appliedOpacity: initialOpacity,

    pendingWrite: null,

    isDirty() {
      const s = get();
      return s.opacity !== s.appliedOpacity;
    },

    hydrate(opacity) {
      const value = opacity ?? 1;
      // Both opacity and appliedOpacity are set to the same value: this is the
      // authoritative persisted value and represents the currently-applied OS
      // window setting.  isDirty() will return false immediately after hydration.
      set({ opacity: value, appliedOpacity: value });
      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(value));
      }
    },

    setOpacity(opacity) {
      set({ opacity });

      // Dual-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(opacity));
      }

      // Track the in-flight IPC write so requestRestart can await it before
      // triggering a restart (pending-write loss mitigation, CRITICAL risk).
      // The sentinel box lets the `finally` callback compare by identity even
      // though the promise is constructed before `set({ pendingWrite })` runs.
      const pendingBox = { current: null as Promise<void> | null };
      const writePromise: Promise<void> = ipcCallResult("appState", "set", {
        windowOpacity: opacity === 1 ? undefined : opacity,
      })
        .then((result) => {
          if (!result.ok) console.warn("[window-opacity] appState set failed", result.message);
        })
        .finally(() => {
          // Clear pendingWrite only if it's still pointing at this same promise.
          if (get().pendingWrite === pendingBox.current) {
            set({ pendingWrite: null });
          }
        });

      pendingBox.current = writePromise;
      set({ pendingWrite: writePromise });
    },
  };
});
