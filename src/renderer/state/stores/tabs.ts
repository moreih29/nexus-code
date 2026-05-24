import { create } from "zustand";
import type { EditorInput } from "@/services/editor/types";
import { killSession } from "@/services/terminal/pty-client";
import { basename } from "@/utils/path";
import type { BrowserTabPayload, DiffTabPayload, GitCommitTabPayload } from "../../../shared/types/tab";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import {
  recordTerminalDeathForAggregate,
  releaseTerminalDeathFromAggregate,
  useTerminalDeathStore,
} from "./terminal-deaths";

// ---------------------------------------------------------------------------
// Types — Tab is a discriminated union, narrowed by `type`. Callers no longer
// cast `tab.props as EditorTabProps`; instead, gating on `tab.type === "editor"`
// gives the compiler a typed `props` automatically.
// ---------------------------------------------------------------------------

export interface TerminalTabProps {
  cwd: string;
  dead?: boolean;
}

export interface UntitledTabProps {
  untitledIndex: number;
}

export type EditorTabProps = EditorInput;
export type DiffTabProps = DiffTabPayload;
export type GitCommitTabProps = GitCommitTabPayload;
export type BrowserTabProps = BrowserTabPayload;

interface TabBase {
  id: string;
  title: string;
  isPreview: boolean;
  isPinned: boolean;
}

export interface EditorTab extends TabBase {
  type: "editor";
  props: EditorTabProps;
  /**
   * Render-mode flag for previewable files (.md, .html, .svg). Default = "raw"
   * (Monaco editor). When "preview", EditorView swaps Monaco for the rendered
   * pane. Persisted per-tab so split panels can hold raw + preview of the
   * same file independently. Undefined for non-previewable files; selectors
   * treat it as "raw".
   */
  viewMode?: "raw" | "preview";
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

export interface UntitledTab extends TabBase {
  type: "untitled";
  props: UntitledTabProps;
}

export interface BrowserTab extends TabBase {
  type: "browser";
  props: BrowserTabProps;
}

export type Tab = EditorTab | DiffTab | TerminalTab | GitCommitTab | UntitledTab | BrowserTab;

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
  | { type: "terminal"; props: TerminalTabProps }
  | { type: "untitled"; props: UntitledTabProps }
  | { type: "browser"; props: BrowserTabProps };

interface TabsState {
  byWorkspace: Record<string, Record<string, Tab>>;
  createTab: (workspaceId: string, args: CreateTabArgs, isPreview?: boolean) => Tab;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
  setTerminalDead: (workspaceId: string, tabId: string, dead: boolean) => void;
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
  /**
   * Toggle the raw/preview render mode for an editor tab. No-op on
   * non-editor tab types or unknown ids.
   */
  setViewMode: (workspaceId: string, tabId: string, mode: "raw" | "preview") => void;
  /**
   * Promote an untitled tab to a saved editor tab. Replaces the tab's type,
   * props, and title in-place, preserving the tab id, isPinned, and
   * isPreview flags. No-op when the tab does not exist or is not untitled.
   */
  replaceUntitledWithEditor: (
    workspaceId: string,
    tabId: string,
    props: EditorTabProps,
    title: string,
  ) => void;
  /**
   * Persist the most-recently visited URL for a browser tab.
   * No-op when the tab does not exist or is not of type "browser".
   */
  setBrowserLastUrl: (workspaceId: string, tabId: string, lastUrl: string) => void;
}

/**
 * Returns the ids of terminal tabs currently marked dead in one workspace.
 */
function deadTerminalIdsForWorkspace(workspaceId: string): Set<string> {
  const tabs = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const ids = new Set<string>();
  for (const tab of Object.values(tabs)) {
    if (tab.type === "terminal" && tab.props.dead) {
      ids.add(tab.id);
    }
  }
  return ids;
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
  if (args.type === "untitled") return `Untitled-${args.props.untitledIndex}`;
  if (args.type === "browser") {
    if (!args.props.initialUrl) return "New Tab";
    try {
      return new URL(args.props.initialUrl).host || "New Tab";
    } catch {
      return "New Tab";
    }
  }
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
      } else if (args.type === "untitled") {
        tab = { ...base, type: "untitled", props: args.props };
      } else if (args.type === "browser") {
        tab = { ...base, type: "browser", props: args.props };
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
      const tab = get().byWorkspace[workspaceId]?.[tabId];
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
      if (tab?.type === "terminal" && tab.props.dead) {
        releaseTerminalDeathFromAggregate(
          workspaceId,
          tabId,
          deadTerminalIdsForWorkspace(workspaceId),
        );
      }
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

    setTerminalDead(workspaceId, tabId, dead) {
      const existingTab = get().byWorkspace[workspaceId]?.[tabId];
      const shouldRecordDeath = existingTab?.type === "terminal" && !existingTab.props.dead && dead;
      const shouldReleaseDeath =
        existingTab?.type === "terminal" && Boolean(existingTab.props.dead) && !dead;

      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || tab?.type !== "terminal" || Boolean(tab.props.dead) === dead) {
          return state;
        }
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...tab, props: { ...tab.props, dead } },
            },
          },
        };
      });

      if (shouldRecordDeath) {
        recordTerminalDeathForAggregate(workspaceId, tabId, () =>
          deadTerminalIdsForWorkspace(workspaceId),
        );
      } else if (shouldReleaseDeath) {
        releaseTerminalDeathFromAggregate(
          workspaceId,
          tabId,
          deadTerminalIdsForWorkspace(workspaceId),
        );
      }
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

    setViewMode(workspaceId, tabId, mode) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        if (tab.type !== "editor") return state;
        if ((tab.viewMode ?? "raw") === mode) return state;
        const next: EditorTab = { ...tab, viewMode: mode };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    replaceUntitledWithEditor(workspaceId, tabId, props, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        if (tab.type !== "untitled") return state;
        const next: EditorTab = {
          id: tab.id,
          title,
          isPreview: tab.isPreview,
          isPinned: tab.isPinned,
          type: "editor",
          props,
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

    setBrowserLastUrl(workspaceId, tabId, lastUrl) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        if (tab.type !== "browser") return state;
        const next: BrowserTab = {
          ...tab,
          props: { ...tab.props, lastUrl },
        };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
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
          killSession(workspaceId, tab.id);
        }
      }

      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
      useTerminalDeathStore.getState().clearWorkspace(workspaceId);
    },
  };
});

// ---------------------------------------------------------------------------
// Untitled counter store — workspace-scoped, monotonically increasing.
// Persisted (via persistence.ts) as part of the normal flush cycle so the
// next session starts above the previously-used index. Not co-located with
// workspaces.ts because the counter is pure renderer UI state — not
// workspace metadata that the main process manages.
// ---------------------------------------------------------------------------

interface UntitledCounterState {
  /** Next untitled index to assign, keyed by workspaceId. Starts at 1. */
  nextByWorkspace: Record<string, number>;
  /**
   * Claim the next untitled index for a workspace and advance the counter.
   * Returns the claimed index (1-based, never reused).
   */
  claimNext: (workspaceId: string) => number;
  /** Reset a workspace's counter (used on workspace cleanup). */
  clearWorkspace: (workspaceId: string) => void;
}

export const useUntitledCounterStore = create<UntitledCounterState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    get().clearWorkspace(id);
  });

  return {
    nextByWorkspace: {},

    claimNext(workspaceId) {
      const current = get().nextByWorkspace[workspaceId] ?? 1;
      set((state) => ({
        nextByWorkspace: {
          ...state.nextByWorkspace,
          [workspaceId]: current + 1,
        },
      }));
      return current;
    },

    clearWorkspace(workspaceId) {
      set((state) => {
        const next = { ...state.nextByWorkspace };
        delete next[workspaceId];
        return { nextByWorkspace: next };
      });
    },
  };
});
