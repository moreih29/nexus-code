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

export function isLspEnabledForWorkspace(workspaceId: string, languageId: string): boolean {
  return isLspLanguageOnForWorkspace(
    useLspSettingsStore.getState().settings,
    workspaceId,
    languageId,
  );
}
