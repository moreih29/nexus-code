// src/renderer/state/stores/focus-island.ts — Tracks which workspace island
// currently holds pointer/keyboard focus.
//
// design.md §5: "unfocused islands get a translucent veil; only the focused
// island stays sharp."
//
// Islands: sidebar | files | editor.
// Default: "editor" (matches typical first-use posture).
// Window blur: last focused island is kept sharp (no all-veil on blur).

import { create } from "zustand";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type FocusedIsland = "sidebar" | "files" | "editor";

interface FocusIslandState {
  focusedIsland: FocusedIsland;
  setFocusedIsland(island: FocusedIsland): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFocusIslandStore = create<FocusIslandState>((set) => ({
  focusedIsland: "editor",

  setFocusedIsland(island) {
    set({ focusedIsland: island });
  },
}));
