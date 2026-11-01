// Which language server's log the log viewer shows, if any. Opened from the
// status bar's language menu and from failure toasts; the dialog is mounted
// once at the App root.

import { create } from "zustand";

export interface LspLogTarget {
  workspaceId: string;
  languageId: string;
}

interface LspLogViewerState {
  target: LspLogTarget | null;
  open(target: LspLogTarget): void;
  close(): void;
}

export const useLspLogViewerStore = create<LspLogViewerState>((set) => ({
  target: null,
  open(target) {
    set({ target });
  },
  close() {
    set({ target: null });
  },
}));
