import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabType = "terminal" | "editor";

export interface TerminalTabProps {
  cwd: string;
}

export interface EditorTabProps {
  filePath: string;
  workspaceId: string;
}

export type TabProps = TerminalTabProps | EditorTabProps;

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  props: TabProps;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (type: TabType, props: TabProps) => Tab;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
}

function defaultTitle(type: TabType, props: TabProps): string {
  if (type === "terminal") return "Terminal";
  const ep = props as EditorTabProps;
  const parts = ep.filePath.split("/");
  return parts[parts.length - 1] ?? "Editor";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab(type, props) {
    const tab: Tab = {
      id: generateId(),
      type,
      title: defaultTitle(type, props),
      props,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }));
    return tab;
  },

  closeTab(id) {
    set((state) => {
      const filtered = state.tabs.filter((t) => t.id !== id);
      let nextActive = state.activeTabId;
      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        const prev = state.tabs[idx - 1];
        const next = state.tabs[idx + 1];
        nextActive = prev?.id ?? next?.id ?? null;
      }
      return { tabs: filtered, activeTabId: nextActive };
    });
  },

  setActiveTab(id) {
    const exists = get().tabs.some((t) => t.id === id);
    if (!exists) return;
    set({ activeTabId: id });
  },
}));
