import { create } from "zustand";
import { cancelTabFocus } from "../../services/tab-focus";

/**
 * Store that manages the active tab id of the tab-name inline edit mode.
 *
 * Intended singleness: only one tab is edited at a time. Starting an edit on another tab with
 * startEditing automatically cancels the previous one (visually only one tab's input is active too).
 *
 * Why this store is a separate module:
 *   - The two entry points, the context menu (GroupTabBar) and double-click (TabItem), must
 *     share the same state. Passing it via props means deep drilling down to TabBar, and contextTabId and
 *     editingTabId get mixed, adding to the parent component's responsibility.
 *   - It is not inside useTabsStore because editing state is UI interaction
 *     state, not data model. It needs no separate management at workspace cleanup either.
 */
interface TabEditingState {
  /** The tab id currently being edited inline. null if none. */
  editingTabId: string | null;
  /** Activates the inline input of that tab. */
  startEditing(tabId: string): void;
  /** Ends edit mode. Both commit and cancel clean up through this function. */
  cancelEditing(): void;
}

export const useTabEditingStore = create<TabEditingState>((set) => ({
  editingTabId: null,
  startEditing(tabId) {
    // A tab's focus still to come (the tab just clicked, a terminal not open
    // yet) would take the name being typed from its field.
    cancelTabFocus();
    set({ editingTabId: tabId });
  },
  cancelEditing() {
    set({ editingTabId: null });
  },
}));
