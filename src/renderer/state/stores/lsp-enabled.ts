// Per-workspace LSP language enabled state.
//
// Source of truth for whether a language server should be started for a
// given (workspace, language) pair. Mirrored from main's appState —
// hydrated at boot via lsp.getEnabledLanguages, updated in real-time via
// the lsp:enabledLanguagesChanged broadcast.
//
// Two access patterns are supported:
//   - React hook (useStore subscription): for components that render
//     toggle chips and need to re-render when enabled state changes.
//   - Sync getter (isLspEnabledForWorkspace): for hot paths such as the
//     attach-lsp-bridge initial didOpen gate, which cannot await a React
//     re-render cycle.

import { create } from "zustand";
import type { LspLanguageId } from "../../../shared/types/app-state";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface LspEnabledState {
  /** workspaceId → list of explicitly enabled language IDs */
  byWorkspace: Record<string, LspLanguageId[]>;

  /** Replace the enabled list for one workspace. */
  setForWorkspace(workspaceId: string, languages: LspLanguageId[]): void;

  /**
   * Bulk-load initial state at bootstrap time. Caller provides a partial
   * record; workspaces not present default to [] (OFF) on first query.
   */
  hydrateAll(initial: Record<string, LspLanguageId[]>): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLspEnabledStore = create<LspEnabledState>((set) => ({
  byWorkspace: {},

  setForWorkspace(workspaceId, languages) {
    set((s) => ({
      byWorkspace: { ...s.byWorkspace, [workspaceId]: languages },
    }));
  },

  hydrateAll(initial) {
    set({ byWorkspace: initial });
  },
}));

// ---------------------------------------------------------------------------
// Sync getter — no React hook; safe to call from non-component code paths
// such as attach-lsp-bridge.
// ---------------------------------------------------------------------------

/**
 * Synchronous read of whether `languageId` is enabled for `workspaceId`.
 * Returns false when the workspace has no enabled list (default OFF).
 *
 * Uses `getState()` directly so it is safe to call outside the React
 * render cycle, in event handlers, and in module-level code.
 */
export function isLspEnabledForWorkspace(workspaceId: string, languageId: string): boolean {
  const languages = useLspEnabledStore.getState().byWorkspace[workspaceId];
  return languages?.includes(languageId as LspLanguageId) ?? false;
}
