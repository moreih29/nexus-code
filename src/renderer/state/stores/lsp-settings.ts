// Language server settings, mirrored from main's appState: hydrated at boot
// and replaced on every lsp:settingsChanged broadcast.
//
// Two access patterns are supported:
//   - React hook (useLspSettingsStore): for the settings panel and the status
//     bar, which re-render when a setting changes.
//   - Sync getter (isLspEnabledForWorkspace): for hot paths such as the
//     attach-lsp-bridge initial didOpen gate, which cannot await a React
//     re-render cycle.

import { create } from "zustand";
import {
  isLspLanguageOnForWorkspace,
  type LspSettings,
  lspSettingsFromState,
} from "../../../shared/lsp/settings";

interface LspSettingsStoreState {
  settings: LspSettings;
  hydrate(settings: LspSettings): void;
}

export const useLspSettingsStore = create<LspSettingsStoreState>((set) => ({
  settings: lspSettingsFromState({}),

  hydrate(settings) {
    set({ settings });
  },
}));

/**
 * Synchronous read of whether `languageId`'s server should run for
 * `workspaceId`. Uses `getState()` directly so it is safe to call outside the
 * React render cycle, in event handlers, and in module-level code.
 */
export function isLspEnabledForWorkspace(workspaceId: string, languageId: string): boolean {
  return isLspLanguageOnForWorkspace(
    useLspSettingsStore.getState().settings,
    workspaceId,
    languageId,
  );
}
