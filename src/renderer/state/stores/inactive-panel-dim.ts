// src/renderer/state/stores/inactive-panel-dim.ts — Inactive-panel dim preference store.
//
// Mirrors the pattern established by state/stores/window-opacity.ts.
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "inactivePanelDim" — boot cache, read synchronously
//     before first paint so the dim level is correct on the first frame.
//
// Semantics: a MULTIPLIER on each theme's tuned inactive-veil alpha (dark
// themes overlay white @0.2, light themes overlay black @0.04 — see
// theme-adapter.ts). 1 = theme default (no change), 0 = no dim, 2 = double the
// default strength. Applied at runtime via useInactivePanelDimEffect →
// --inactive-panel-dim CSS var → the veil token's calc() in the generated
// theme CSS. Takes effect immediately — no restart required.

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = createLogger("inactive-panel-dim");

const INACTIVE_PANEL_DIM_STORAGE_KEY = "inactivePanelDim";

/** Theme-default multiplier — 1 means "use each theme's tuned veil alpha". */
export const INACTIVE_PANEL_DIM_DEFAULT = 1;
/** Slider range: 0 = no dim, 2 = double the theme-default strength. */
export const INACTIVE_PANEL_DIM_MIN = 0;
export const INACTIVE_PANEL_DIM_MAX = 2;

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface InactivePanelDimState {
  /** Multiplier applied to the theme's inactive-veil alpha. Range: [0, 2]. */
  dim: number;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(dim: number | undefined): void;

  /**
   * Set the inactive-panel dim multiplier.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   */
  setDim(dim: number): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useInactivePanelDimStore = create<InactivePanelDimState>((set) => {
  // Derive initial value from localStorage (written on a prior session). Falls
  // back to the theme default (1) if absent/invalid/out-of-range.
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

    setDim(dim) {
      set({ dim });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(INACTIVE_PANEL_DIM_STORAGE_KEY, String(dim));
      }
      // Authoritative write — fire-and-forget; the next boot's hydrate() will
      // re-read whatever made it to disk. Errors are logged only.
      void ipcCallResult("appState", "set", {
        inactivePanelDim: dim === INACTIVE_PANEL_DIM_DEFAULT ? undefined : dim,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },
  };
});
