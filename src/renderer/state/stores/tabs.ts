import i18next from "i18next";
import { create } from "zustand";
import type { EditorInput } from "@/services/editor/types";
import { killSession } from "@/services/terminal/pty-client";
import { basename } from "@/utils/path";
import { type RelayedMessage, withRelayedMessage } from "../../../shared/chat/relay";
import type { ShellChoice } from "../../../shared/pty/shell";
import {
  PROFILE_MOVES_KEPT,
  type ProfileMove,
  type SerializedTab,
} from "../../../shared/types/layout";
import type {
  BrowserTabPayload,
  DiffTabPayload,
  GitCommitTabPayload,
} from "../../../shared/types/tab";
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
  /** The shell the tab was opened with; absent = the default shell setting. */
  shell?: ShellChoice;
  dead?: boolean;
}

export interface UntitledTabProps {
  untitledIndex: number;
}

export type EditorTabProps = EditorInput;
export type DiffTabProps = DiffTabPayload;
export type GitCommitTabProps = GitCommitTabPayload;
export type BrowserTabProps = BrowserTabPayload;

export interface ClaudeTabProps {
  cwd: string;
  /** The session the tab last had, to go on with once its program is gone. */
  sessionId?: string;
  /**
   * The session the tab's program copies, up to a message, until the copy
   * has its own id: set on a tab opened as a fork, rewound, or gone on with
   * in another profile (which keeps the session: `profileId`).
   */
  fork?: { sessionId: string; at?: string; title?: string; profileId?: string };
  /** The agent profile its program runs with; absent = the default. */
  profileId?: string;
  /** Where the conversation went on in another profile. */
  moves?: readonly ProfileMove[];
  /** Who sent the messages other agents sent it through the nexus command. */
  relayed?: readonly RelayedMessage[];
}

export interface CodexTabProps {
  cwd: string;
  /** The thread the tab last had, to go on with once its program is gone. */
  threadId?: string;
  /**
   * The thread a tab opened as a fork copies, until the copy has its own id
   * (/fork); one another profile keeps names it (`profileId`).
   */
  fork?: { threadId: string; title?: string; profileId?: string };
  /** The agent profile its program runs with; absent = the default. */
  profileId?: string;
  /** Where the conversation went on in another profile. */
  moves?: readonly ProfileMove[];
  /** Who sent the messages other agents sent it through the nexus command. */
  relayed?: readonly RelayedMessage[];
}

interface TabBase {
  id: string;
  /**
   * Display title — derived: customTitle ?? processTitle ?? defaultTitle.
   * Every set path (rename / setProcessTitle / createTab) maintains this invariant.
   * Callers can always read tab.title as is.
   */
  title: string;
  /**
   * Default title computed when the tab is created. Fallback when customTitle and
   * processTitle are both empty. Does not change after createTab.
   */
  defaultTitle: string;
  /**
   * Title the user set manually. When set it hides processTitle and pins the title.
   * Clearing it to undefined returns to automatic (processTitle/defaultTitle).
   */
  customTitle?: string;
  /**
   * Auto-detected title. Updated from OSC 0/1/2 (xterm.js onTitleChange) for terminals and
   * page-title-updated for browsers. Has no effect on the display when customTitle is set.
   */
  processTitle?: string;
  isPreview: boolean;
  isPinned: boolean;
}

/** Title invariant computation: customTitle ?? processTitle ?? defaultTitle. */
function computeDisplayTitle(parts: {
  defaultTitle: string;
  customTitle?: string;
  processTitle?: string;
}): string {
  return parts.customTitle ?? parts.processTitle ?? parts.defaultTitle;
}

export interface EditorTab extends TabBase {
  type: "editor";
  props: EditorTabProps;
  /**
   * Render-mode flag for previewable files (.md, .html, .svg). When
   * "preview", EditorView swaps Monaco for the rendered pane. Persisted
   * per-tab so split panels can hold raw + preview of the same file
   * independently. Undefined until the tab is switched: a previewable file
   * then shows its preview, anything else its source (`defaultViewMode`).
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

/** A conversation with Claude Code, driven through its stream-json mode. */
export interface ClaudeTab extends TabBase {
  type: "claude";
  props: ClaudeTabProps;
}

/** A conversation with Codex, driven through `codex app-server`. */
export interface CodexTab extends TabBase {
  type: "codex";
  props: CodexTabProps;
}

export type Tab =
  | EditorTab
  | DiffTab
  | TerminalTab
  | GitCommitTab
  | UntitledTab
  | BrowserTab
  | ClaudeTab
  | CodexTab;

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
  | { type: "browser"; props: BrowserTabProps }
  | { type: "claude"; props: ClaudeTabProps }
  | { type: "codex"; props: CodexTabProps };

interface TabsState {
  byWorkspace: Record<string, Record<string, Tab>>;
  createTab: (workspaceId: string, args: CreateTabArgs, isPreview?: boolean) => Tab;
  removeTab: (workspaceId: string, tabId: string) => void;
  /**
   * Manual rename by the user. If title === "" (or empty after trim), customTitle is
   * cleared, automatically returning to processTitle/defaultTitle.
   * External callers (commit detail fetch etc.) should use setProcessTitle for the meaning to fit —
   * renameTab carries the meaning of user intent.
   */
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
  /**
   * Updates the auto-detected title. Called from terminal OSC 0/1/2, browser page-title-updated, etc.
   * If title === null or an empty string, processTitle is cleared. If customTitle is
   * set the displayed title does not change but the processTitle value is still updated —
   * so that clearing customTitle later returns to the latest processTitle.
   */
  setProcessTitle: (workspaceId: string, tabId: string, title: string | null) => void;
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
  /**
   * Point an editor tab at `filePath` after its file was renamed or moved.
   * Keeps the tab's id, pin, preview and view-mode state and a title the user
   * gave it; the default title follows the new file name. No-op on other tab
   * types or unknown ids.
   */
  retargetEditorTab: (workspaceId: string, tabId: string, filePath: string) => void;
  /**
   * Swap a diff preview tab's props (path / refs) in place, keeping its id and
   * `isPreview: true`. Used by `openDiffTab` for VSCode-style "click another
   * file in the SCM panel → reuse the preview slot" behaviour. Title is
   * recomputed externally and passed in so this method stays a pure state op.
   * No-op on non-`editor.diff` tab ids.
   */
  replaceDiffPreviewTab: (
    workspaceId: string,
    tabId: string,
    props: DiffTabProps,
    title: string,
  ) => void;
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
  /**
   * Keep the session a Claude tab now has, and drop the fork it was opened
   * with. No-op on other tab types.
   */
  setClaudeSession: (workspaceId: string, tabId: string, sessionId: string) => void;
  /**
   * Set what a Claude tab's program starts from: its session, and the one it
   * copies until the copy has its own id (a rewind). No-op on other tab types.
   */
  setClaudeTarget: (
    workspaceId: string,
    tabId: string,
    target: {
      sessionId?: string;
      fork?: { sessionId: string; at?: string; title?: string; profileId?: string };
    },
  ) => void;
  /**
   * Keep where a Claude or Codex tab's conversation went on in another
   * profile; none drops them. No-op on other tab types.
   */
  setChatMoves: (workspaceId: string, tabId: string, moves: readonly ProfileMove[]) => void;
  /** Keeps who sent a message through the nexus command; one with its id is replaced. */
  addChatRelayed: (workspaceId: string, tabId: string, record: RelayedMessage) => void;
  /** Keep the thread a Codex tab now has. No-op on other tab types. */
  setCodexThread: (workspaceId: string, tabId: string, threadId: string) => void;
  /**
   * Set the agent profile a Claude or Codex tab runs with: an empty tab that
   * takes up a session another profile keeps, or one the user switches. The
   * session or thread it had is the old profile's, so it goes. No-op on
   * other tab types.
   */
  setChatProfile: (workspaceId: string, tabId: string, profileId: string | undefined) => void;
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
  if (args.type === "terminal") return terminalTitle(1);
  if (args.type === "editor.diff") {
    if (args.props.oldRelPath) return `${args.props.oldRelPath} → ${args.props.relPath}`;
    return basename(args.props.relPath) || "Diff";
  }
  if (args.type === "git.commit") return `commit ${args.props.sha.slice(0, 7)}`;
  if (args.type === "untitled") return `Untitled-${args.props.untitledIndex}`;
  if (args.type === "claude") return i18next.t("common:chat.tab_title");
  if (args.type === "codex") return i18next.t("common:chat.codex.tab_title");
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

/**
 * The titles a tab restored from a snapshot starts with: as they were
 * saved, but a name the app gives (a chat tab's, the agent list's), worked
 * out again in the app's language. A snapshot from before the titles were
 * kept has the shown one alone: a chat tab's is its conversation's unless
 * it is the tab's name, any other tab's is taken for its name.
 */
export function restoredTitles(
  tab: SerializedTab,
): Pick<TabBase, "title" | "defaultTitle" | "customTitle" | "processTitle"> {
  const chat = tab.type === "claude" || tab.type === "codex";
  const name = chat ? defaultTitle(tab) : (tab.defaultTitle ?? tab.title);
  const { customTitle } = tab;
  const older = tab.defaultTitle === undefined;
  const processTitle =
    older && chat ? (tab.title !== name ? tab.title : undefined) : tab.processTitle;
  return {
    defaultTitle: name,
    customTitle,
    processTitle,
    title: computeDisplayTitle({ defaultTitle: name, customTitle, processTitle }),
  };
}

/** "Terminal" for the first terminal, "Terminal 2", "Terminal 3", … after. */
function terminalTitle(index: number): string {
  return index === 1
    ? i18next.t("common:terminal.default_title")
    : i18next.t("common:terminal.numbered_title", { index });
}

/**
 * Picks the lowest-numbered terminal title no terminal tab in the workspace
 * is using, so several terminals can be told apart in the tab bar.
 */
function nextTerminalTitle(tabs: Record<string, Tab> | undefined): string {
  const used = new Set<string>();
  for (const tab of Object.values(tabs ?? {})) {
    if (tab.type === "terminal") used.add(tab.defaultTitle);
  }
  for (let index = 1; ; index++) {
    const title = terminalTitle(index);
    if (!used.has(title)) return title;
  }
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
      const dt =
        args.type === "terminal"
          ? nextTerminalTitle(get().byWorkspace[workspaceId])
          : defaultTitle(args);
      const base = {
        id: crypto.randomUUID(),
        // Initially there is neither customTitle nor processTitle, so the derived title = defaultTitle.
        title: dt,
        defaultTitle: dt,
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
      } else if (args.type === "claude") {
        tab = { ...base, type: "claude", props: args.props };
      } else if (args.type === "codex") {
        tab = { ...base, type: "codex", props: args.props };
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
        const tab = wsRecord[tabId];

        // An empty string after trim is read as clearing customTitle — return to processTitle/defaultTitle.
        const trimmed = title.trim();
        const nextCustom = trimmed === "" ? undefined : trimmed;
        const nextDisplay = computeDisplayTitle({
          defaultTitle: tab.defaultTitle,
          customTitle: nextCustom,
          processTitle: tab.processTitle,
        });

        if (nextCustom === tab.customTitle && nextDisplay === tab.title) return state;

        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...tab, customTitle: nextCustom, title: nextDisplay },
            },
          },
        };
      });
    },

    setProcessTitle(workspaceId, tabId, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];

        // Empty string / null → clear processTitle.
        const trimmed = title === null ? "" : title.trim();
        const nextProcess = trimmed === "" ? undefined : trimmed;
        const nextDisplay = computeDisplayTitle({
          defaultTitle: tab.defaultTitle,
          customTitle: tab.customTitle,
          processTitle: nextProcess,
        });

        if (nextProcess === tab.processTitle && nextDisplay === tab.title) return state;

        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...wsRecord,
              [tabId]: { ...tab, processTitle: nextProcess, title: nextDisplay },
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
        // The file the tab points to changes, so update defaultTitle to the new file name and
        // clear the old customTitle / processTitle, which no longer mean anything.
        const next: EditorTab = {
          ...tab,
          props,
          title,
          defaultTitle: title,
          customTitle: undefined,
          processTitle: undefined,
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

    retargetEditorTab(workspaceId, tabId, filePath) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || tab?.type !== "editor" || tab.props.filePath === filePath) return state;
        const nextDefault = defaultTitle({ type: "editor", props: { ...tab.props, filePath } });
        const next: EditorTab = {
          ...tab,
          props: { ...tab.props, filePath },
          defaultTitle: nextDefault,
          title: computeDisplayTitle({
            defaultTitle: nextDefault,
            customTitle: tab.customTitle,
            processTitle: tab.processTitle,
          }),
        };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    replaceDiffPreviewTab(workspaceId, tabId, props, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        // Targets only the editor.diff slot — editor / git.commit previews are owned by their own actions.
        if (tab.type !== "editor.diff") return state;
        // path / refs change, so update defaultTitle to the new value and
        // clear the previous custom/process title, which no longer means anything (removes leftovers from the old file/ref).
        const next: DiffTab = {
          ...tab,
          props,
          title,
          defaultTitle: title,
          customTitle: undefined,
          processTitle: undefined,
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

    replaceCommitPreviewTab(workspaceId, tabId, sha, title) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const tab = wsRecord[tabId];
        // Commit preview has its own slot; editor previews are intentionally
        // left untouched by this replacement path.
        if (tab.type !== "git.commit") return state;
        // The SHA changes, so update defaultTitle to the new placeholder ("commit XXXXXXX") and
        // clear the old custom/process title (the previous commit's subject etc. must not remain).
        const next: GitCommitTab = {
          ...tab,
          props: { workspaceId, sha },
          title,
          defaultTitle: title,
          customTitle: undefined,
          processTitle: undefined,
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
        if (tab.viewMode === mode) return state;
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
        // Untitled → saved editor transition. Take the new file name as defaultTitle and
        // start with custom/process cleared.
        const next: EditorTab = {
          id: tab.id,
          title,
          defaultTitle: title,
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

    setCodexThread(workspaceId, tabId, threadId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || tab?.type !== "codex") return state;
        if (tab.props.threadId === threadId && !tab.props.fork) return state;
        // A fork's copy has its own id now: the tab goes on with it.
        const { fork: _copied, ...props } = tab.props;
        const next: CodexTab = { ...tab, props: { ...props, threadId } };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    setChatProfile(workspaceId, tabId, profileId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || (tab?.type !== "claude" && tab?.type !== "codex")) return state;
        if (tab.props.profileId === profileId) return state;
        // The messages' senders, by id: kept for a conversation that goes on.
        const props = {
          cwd: tab.props.cwd,
          ...(profileId ? { profileId } : {}),
          ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
        };
        const next = { ...tab, props } as Tab;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    setClaudeSession(workspaceId, tabId, sessionId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || tab?.type !== "claude") return state;
        if (tab.props.sessionId === sessionId && !tab.props.fork) return state;
        const next: ClaudeTab = {
          ...tab,
          props: {
            cwd: tab.props.cwd,
            sessionId,
            ...(tab.props.profileId ? { profileId: tab.props.profileId } : {}),
            ...(tab.props.moves ? { moves: tab.props.moves } : {}),
            ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
          },
        };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    setClaudeTarget(workspaceId, tabId, { sessionId, fork }) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || tab?.type !== "claude") return state;
        const next: ClaudeTab = {
          ...tab,
          props: {
            cwd: tab.props.cwd,
            ...(sessionId ? { sessionId } : {}),
            ...(fork ? { fork } : {}),
            ...(tab.props.profileId ? { profileId: tab.props.profileId } : {}),
            ...(tab.props.moves ? { moves: tab.props.moves } : {}),
            ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
          },
        };
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    setChatMoves(workspaceId, tabId, moves) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || (tab?.type !== "claude" && tab?.type !== "codex")) return state;
        if (moves.length === 0 && !tab.props.moves) return state;
        const { moves: _old, ...rest } = tab.props;
        const props =
          moves.length > 0 ? { ...rest, moves: moves.slice(-PROFILE_MOVES_KEPT) } : rest;
        const next = { ...tab, props } as Tab;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
          },
        };
      });
    },

    addChatRelayed(workspaceId, tabId, record) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        const tab = wsRecord?.[tabId];
        if (!wsRecord || (tab?.type !== "claude" && tab?.type !== "codex")) return state;
        const relayed = withRelayedMessage(tab.props.relayed, record);
        const next = { ...tab, props: { ...tab.props, relayed } } as Tab;
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: { ...wsRecord, [tabId]: next },
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
