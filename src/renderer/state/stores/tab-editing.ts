import { create } from "zustand";
import { cancelTabFocus } from "../../services/tab-focus";

interface TabEditingState {
  editingTabId: string | null;
  startEditing(tabId: string): void;
  cancelEditing(): void;
}

export const useTabEditingStore = create<TabEditingState>((set) => ({
  editingTabId: null,
  startEditing(tabId) {
    cancelTabFocus();
    set({ editingTabId: tabId });
  },
  cancelEditing() {
    set({ editingTabId: null });
  },
}));
