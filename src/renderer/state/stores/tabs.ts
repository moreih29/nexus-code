import { create } from "zustand";
import type { EditorInput } from "@/services/editor/types";
import { killSession } from "@/services/terminal/pty-client";
import { basename } from "@/utils/path";
import type { DiffTabPayload, GitCommitTabPayload } from "../../../shared/types/tab";
import { registerWorkspaceCleanup } from "../lifecycle/workspace-cleanup";

// ---------------------------------------------------------------------------
// Types — Tab is a discriminated union, narrowed by `type`. Callers no longer
// cast `tab.props as EditorTabProps`; instead, gating on `tab.type === "editor"`
// gives the compiler a typed `props` automatically.
// ---------------------------------------------------------------------------

export type TabType = "terminal" | "editor" | "editor.diff" | "git.commit";

export interface TerminalTabProps {
  cwd: string;
}

export type EditorTabProps = EditorInput;
export type DiffTabProps = DiffTabPayload;
export type GitCommitTabProps = GitCommitTabPayload;

export type TabProps = TerminalTabProps | EditorTabProps | DiffTabProps | GitCommitTabProps;

interface TabBase {
  id: string;
  title: string;
  isPreview: boolean;
  isPinned: boolean;
}

export interface EditorTab extends TabBase {
  type: "editor";
  props: EditorTabProps;
}

export interface DiffTab extends TabBase {
  type: "editor.diff";
  props: DiffTabProps;
}

export interface TerminalTab extends TabBase {
  type: "terminal";
  props: TerminalTabProps;
}

export interface GitCommitTab extends TabBase {
  type: "git.commit";
  props: GitCommitTabProps;
}

export type Tab = EditorTab | DiffTab | TerminalTab | GitCommitTab;

// ---------------------------------------------------------------------------
// State shape — flat record registry; ordering and active state live in layout.ts
// ---------------------------------------------------------------------------

/**
 * Discriminated input for `createTab`. Keeping `(type, props)` together as
 * a tagged record means the compiler refuses mismatched pairs at the call
 * site, and the body can branch on `args.type` to construct the matching
 * Tab branch without casts.
 */
export type CreateTabArgs =
  | { type: "editor"; props: EditorTabProps }
  | { type: "editor.diff"; props: DiffTabProps }
  | { type: "git.commit"; props: GitCommitTabProps }
  | { type: "terminal"; props: TerminalTabProps };

interface TabsState {
  byWorkspace: Record<string, Record<string, Tab>>;
  createTab: (workspaceId: string, args: CreateTabArgs, isPreview?: boolean) => Tab;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
  promoteFromPreview: (workspaceId: string, tabId: string) => void;
  replacePreviewTab: (
    workspaceId: string,
    tabId: string,
    props: EditorTabProps,
    title: string,
  ) => void;
  replaceCommitPreviewTab: (workspaceId: string, tabId: string, sha: string, title: string) => void;
  togglePin: (workspaceId: string, tabId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the display title used for a new tab when the caller does not
 * provide an explicit rename after creation.
 */
export function defaultTitle(args: CreateTabArgs): string {
  if (args.type === "terminal") return "Terminal";
  if (args.type === "editor.diff") {
    if (args.props.oldRelPath) return `${args.props.oldRelPath} → ${args.props.relPath}`;
    return basename(args.props.relPath) || "Diff";
  }
  if (args.type === "git.commit") return `commit ${args.props.sha.slice(0, 7)}`;
  return basename(args.props.filePath) || "Editor";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTabsStore = create<TabsState>((set, get) => {
  // A deleted workspace's tab records (and their PTYs) are cleaned up via
  // the central workspace-cleanup registry — no need to re-implement the
  // IPC listener here.
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  return {
    byWorkspace: {},

    createTab(workspaceId, args, isPreview = false) {
      const base = {
        id: crypto.randomUUID(),
        title: defaultTitle(args),
        isPreview,
        isPinned: false,
      };
      let tab: Tab;
      if (args.type === "editor") {
        tab = { ...base, type: "editor", props: args.props };
      } else if (args.type === "editor.diff") {
        tab = { ...base, type: "editor.diff", props: args.props };
      } else if (args.type === "git.commit") {
        tab = { ...base, type: "git.commit", props: args.props };
      } else {
        tab = { ...base, type: "terminal", props: args.props };
      }
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
        // Only editor tabs have a preview slot; replace is otherwise a no-op.
        if (tab.type !== "editor") return state;
        const next: EditorTab = { ...tab, props, title, isPreview: true };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: next,
            },
          },
        };
      });
    },

    replaceCommitPreviewTab(workspaceId, tabId, sha, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        // Commit preview has its own slot; editor previews are intentionally
        // left untouched by this replacement path.
        if (tab.type !== "git.commit") return state;
        const next: GitCommitTab = {
          ...tab,
          props: { workspaceId, sha },
          title,
          isPreview: true,
        };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: next,
            },
          },
        };
      });
    },

    togglePin(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        const nextPinned = !tab.isPinned;
        // Pin implies permanent: clear preview flag when pinning. Reconstruct
        // each branch so the union narrowing survives the spread.
        const updatedTab: Tab =
          tab.type === "editor"
            ? { ...tab, isPinned: nextPinned, isPreview: nextPinned ? false : tab.isPreview }
            : tab.type === "editor.diff"
              ? { ...tab, isPinned: nextPinned, isPreview: nextPinned ? false : tab.isPreview }
              : tab.type === "git.commit"
                ? { ...tab, isPinned: nextPinned, isPreview: nextPinned ? false : tab.isPreview }
                : { ...tab, isPinned: nextPinned, isPreview: nextPinned ? false : tab.isPreview };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: updatedTab },
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
