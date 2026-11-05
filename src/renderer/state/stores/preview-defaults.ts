/**
 * The view each format with a preview opens in, as Settings › Editor sets
 * it: its source or its preview. A format left out opens as it does by
 * default (defaultViewMode). Persists in AppState.
 */

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";
import {
  isPreviewEngine,
  type PreviewEngine,
  type ViewMode,
  type ViewModeDefaults,
} from "../../services/editor/preview/previewable";

const log = createLogger("preview-defaults");

interface PreviewDefaultsState {
  byFormat: ViewModeDefaults;
  hydrate(stored: AppState["previewViewDefaults"]): void;
  /** Sets the view `format` opens in; undefined goes back to its default. */
  setDefault(format: PreviewEngine, mode: ViewMode | undefined): void;
  /** Every format back to its default. */
  clear(): void;
}

function persist(byFormat: ViewModeDefaults): void {
  void ipcCallResult("appState", "set", { previewViewDefaults: { ...byFormat } }).then((result) => {
    if (!result.ok) log.warn(`appState set (preview defaults) failed: ${result.message}`);
  });
}

export const usePreviewDefaultsStore = create<PreviewDefaultsState>((set, get) => ({
  byFormat: {},

  hydrate(stored) {
    const byFormat: Partial<Record<PreviewEngine, ViewMode>> = {};
    for (const [format, mode] of Object.entries(stored ?? {})) {
      if (isPreviewEngine(format)) byFormat[format] = mode;
    }
    set({ byFormat });
  },

  setDefault(format, mode) {
    const { [format]: _previous, ...rest } = get().byFormat;
    const byFormat: ViewModeDefaults = mode === undefined ? rest : { ...rest, [format]: mode };
    set({ byFormat });
    persist(byFormat);
  },

  clear() {
    set({ byFormat: {} });
    persist({});
  },
}));
