/**
 * Zustand store for the file clipboard (cut/copy buffer).
 *
 * Auto-clears on workspace switch via a `useActiveStore.subscribe` hook.
 */

import { create } from "zustand";
import { useActiveStore } from "@/state/stores/active";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClipboardEntry {
  relPath: string;
  absPath: string;
}

export interface FileClipboardState {
  kind: "cut" | "copy" | null;
  workspaceId: string;
  entries: ClipboardEntry[];
  sourceRootPath: string;

  set: (
    kind: "cut" | "copy",
    workspaceId: string,
    entries: ClipboardEntry[],
    sourceRootPath: string,
  ) => void;
  clear: () => void;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const init: Pick<FileClipboardState, "kind" | "workspaceId" | "entries" | "sourceRootPath"> = {
  kind: null,
  workspaceId: "",
  entries: [],
  sourceRootPath: "",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFileClipboardStore = create<FileClipboardState>((set) => ({
  ...init,

  set(kind, workspaceId, entries, sourceRootPath) {
    set({ kind, workspaceId, entries, sourceRootPath });
  },

  clear() {
    set(init);
  },
}));

// ---------------------------------------------------------------------------
// Auto-clear on workspace switch
// ---------------------------------------------------------------------------

useActiveStore.subscribe((state, prev) => {
  if (state.activeWorkspaceId !== prev.activeWorkspaceId) {
    useFileClipboardStore.getState().clear();
  }
});