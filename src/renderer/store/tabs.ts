import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ipcListen } from "../ipc/client";

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

interface WorkspaceSlice {
  tabs: Tab[];
  activeTabId: string | null;
}

const EMPTY_SLICE: WorkspaceSlice = { tabs: [], activeTabId: null };

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface TabsState {
  byWorkspace: Record<string, WorkspaceSlice>;
  addTab: (workspaceId: string, type: TabType, props: TabProps) => Tab;
  closeTab: (workspaceId: string, id: string) => void;
  setActiveTab: (workspaceId: string, id: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
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

export const useTabsStore = create<TabsState>((set, get) => {
  // Mirror the workspaces store pattern: subscribe to main-process removed
  // events so a deleted workspace's tab metadata is cleaned up automatically,
  // regardless of where the deletion was initiated.
  // The `typeof window` guard keeps the module importable from bun:test where
  // `window.ipc` isn't installed.
  if (typeof window !== "undefined") {
    ipcListen("workspace", "removed", ({ id }) => {
      get().closeAllForWorkspace(id);
    });
  }

  return {
    byWorkspace: {},

    addTab(workspaceId, type, props) {
      const tab: Tab = {
        id: generateId(),
        type,
        title: defaultTitle(type, props),
        props,
      };
      set((state) => {
        const slice = state.byWorkspace[workspaceId] ?? EMPTY_SLICE;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              tabs: [...slice.tabs, tab],
              activeTabId: tab.id,
            },
          },
        };
      });
      return tab;
    },

    closeTab(workspaceId, id) {
      set((state) => {
        const slice = state.byWorkspace[workspaceId];
        if (!slice) return state;
        const idx = slice.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return state;

        const filtered = slice.tabs.filter((t) => t.id !== id);
        let nextActive = slice.activeTabId;
        if (slice.activeTabId === id) {
          const prev = slice.tabs[idx - 1];
          const next = slice.tabs[idx + 1];
          nextActive = prev?.id ?? next?.id ?? null;
        }
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { tabs: filtered, activeTabId: nextActive },
          },
        };
      });
    },

    setActiveTab(workspaceId, id) {
      const slice = get().byWorkspace[workspaceId];
      if (!slice) return;
      if (!slice.tabs.some((t) => t.id === id)) return;
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: { ...state.byWorkspace[workspaceId], activeTabId: id },
        },
      }));
    },

    closeAllForWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Selector hook — returns a stable empty slice when workspaceId is null /
// missing so consumers don't need to null-check the slice shape.
// ---------------------------------------------------------------------------

export function useWorkspaceTabs(workspaceId: string | null): WorkspaceSlice {
  return useTabsStore(
    useShallow((s) => (workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY_SLICE) : EMPTY_SLICE)),
  );
}
