import { create } from "zustand";
import type { EditorInput } from "@/services/editor/types";
import { killSession } from "@/services/terminal/pty-client";
import { ipcListen } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabType = "terminal" | "editor";

export interface TerminalTabProps {
  cwd: string;
}

export type EditorTabProps = EditorInput;

export type TabProps = TerminalTabProps | EditorTabProps;

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  props: TabProps;
  isPreview: boolean;
}

// ---------------------------------------------------------------------------
// State shape — flat record registry; ordering and active state live in layout.ts
// ---------------------------------------------------------------------------

interface TabsState {
  byWorkspace: Record<string, Record<string, Tab>>;
  createTab: (workspaceId: string, type: TabType, props: TabProps, isPreview?: boolean) => Tab;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
  promoteFromPreview: (workspaceId: string, tabId: string) => void;
  replacePreviewTab: (workspaceId: string, tabId: string, props: TabProps, title: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function defaultTitle(type: TabType, props: TabProps): string {
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

    createTab(workspaceId, type, props, isPreview = false) {
      const tab: Tab = {
        id: crypto.randomUUID(),
        type,
        title: defaultTitle(type, props),
        props,
        isPreview,
      };
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: {
            ...(state.byWorkspace[workspaceId] ?? {}),
            [tab.id]: tab,
          },
        },
      }));
      return tab;
    },

    removeTab(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const next = { ...wsRecord };
        delete next[tabId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: next,
          },
        };
      });
    },

    renameTab(workspaceId, tabId, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...wsRecord[tabId], title },
            },
          },
        };
      });
    },

    promoteFromPreview(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        if (!tab.isPreview) return state;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...tab, isPreview: false },
            },
          },
        };
      });
    },

    replacePreviewTab(workspaceId, tabId, props, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...tab, props, title, isPreview: true },
            },
          },
        };
      });
    },

    closeAllForWorkspace(workspaceId) {
      const wsRecord = get().byWorkspace[workspaceId];
      if (!wsRecord) return;

      for (const tab of Object.values(wsRecord)) {
        if (tab.type === "terminal") {
          killSession(tab.id);
        }
      }

      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
    },
  };
});
