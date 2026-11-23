import i18next from "i18next";
import { create } from "zustand";
import type { EditorInput } from "@/services/editor/types";
import { killSession } from "@/services/terminal/pty-client";
import { basename } from "@/utils/path";
import {
  type AppMessage,
  RELAYED_KEPT,
  type RelayedMessage,
  type TerminalOpener,
  withRelayedMessage,
} from "../../../shared/chat/relay";
import type { ShellChoice } from "../../../shared/pty/shell";
import {
  type ChatAttachments,
  type ChatChosen,
  type CodexFork,
  type LimitResume,
  MAX_CHAT_PEER_SUBMISSIONS,
  type NoteTabProps,
  PROFILE_MOVES_KEPT,
  type ProfileMove,
  type SerializedTab,
} from "../../../shared/types/layout";
import type {
  BrowserTabPayload,
  DiffTabPayload,
  GitCommitTabPayload,
} from "../../../shared/types/tab";
import type { PeerSubmission } from "../../services/chat/transport/submission";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import {
  recordTerminalDeathForAggregate,
  releaseTerminalDeathFromAggregate,
  useTerminalDeathStore,
} from "./terminal-deaths";

export interface TerminalTabProps {
  cwd: string;
  shell?: ShellChoice;
  profile?: string;
  openedBy?: TerminalOpener;
  dead?: boolean;
}

export interface UntitledTabProps {
  untitledIndex: number;
}

export type EditorTabProps = EditorInput;
export type DiffTabProps = DiffTabPayload;
export type GitCommitTabProps = GitCommitTabPayload;
export type BrowserTabProps = BrowserTabPayload;
export type { NoteTabProps };

export interface ClaudeTabProps {
  cwd: string;
  openedBy?: TerminalOpener;
  instructions?: string;
  sessionId?: string;
  fork?: { sessionId: string; at?: string; title?: string; profileId?: string };
  profileId?: string;
  moves?: readonly ProfileMove[];
  relayed?: readonly RelayedMessage[];
  fromApp?: readonly AppMessage[];
  peerSubmissions?: Readonly<Record<string, PeerSubmission>>;
  chosen?: ChatChosen;
  limitResume?: LimitResume;
  attachments?: ChatAttachments;
}

export interface CodexTabProps {
  cwd: string;
  openedBy?: TerminalOpener;
  instructions?: string;
  threadId?: string;
  fork?: CodexFork;
  profileId?: string;
  moves?: readonly ProfileMove[];
  relayed?: readonly RelayedMessage[];
  fromApp?: readonly AppMessage[];
  peerSubmissions?: Readonly<Record<string, PeerSubmission>>;
  chosen?: ChatChosen;
  limitResume?: LimitResume;
  attachments?: ChatAttachments;
}

interface TabBase {
  id: string;
  openedAt?: number;
  title: string;
  defaultTitle: string;
  customTitle?: string;
  processTitle?: string;
  isPreview: boolean;
  isPinned: boolean;
}

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

export interface NoteTab extends TabBase {
  type: "note";
  props: NoteTabProps;
}

export interface ClaudeTab extends TabBase {
  type: "claude";
  props: ClaudeTabProps;
}

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
  | NoteTab
  | ClaudeTab
  | CodexTab;

export type CreateTabArgs =
  | { type: "editor"; props: EditorTabProps }
  | { type: "editor.diff"; props: DiffTabProps }
  | { type: "git.commit"; props: GitCommitTabProps }
  | { type: "terminal"; props: TerminalTabProps }
  | { type: "untitled"; props: UntitledTabProps }
  | { type: "browser"; props: BrowserTabProps }
  | { type: "note"; props: NoteTabProps }
  | { type: "claude"; props: ClaudeTabProps }
  | { type: "codex"; props: CodexTabProps };

interface TabsState {
  byWorkspace: Record<string, Record<string, Tab>>;
  createTab: (workspaceId: string, args: CreateTabArgs, isPreview?: boolean) => Tab;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
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
  retargetEditorTab: (workspaceId: string, tabId: string, filePath: string) => void;
  retargetWorkingDiffTab: (workspaceId: string, tabId: string, relPath: string) => void;
  replaceDiffPreviewTab: (
    workspaceId: string,
    tabId: string,
    props: DiffTabProps,
    title: string,
  ) => void;
  togglePin: (workspaceId: string, tabId: string) => void;
  setViewMode: (workspaceId: string, tabId: string, mode: "raw" | "preview") => void;
  replaceUntitledWithEditor: (
    workspaceId: string,
    tabId: string,
    props: EditorTabProps,
    title: string,
  ) => void;
  setBrowserLastUrl: (workspaceId: string, tabId: string, lastUrl: string) => void;
  setClaudeSession: (workspaceId: string, tabId: string, sessionId: string) => void;
  setClaudeTarget: (
    workspaceId: string,
    tabId: string,
    target: {
      sessionId?: string;
      fork?: { sessionId: string; at?: string; title?: string; profileId?: string };
    },
  ) => void;
  setChatMoves: (workspaceId: string, tabId: string, moves: readonly ProfileMove[]) => void;
  setChatInstructions: (
    workspaceId: string,
    tabId: string,
    instructions: string | undefined,
  ) => void;
  setChatChosen: (workspaceId: string, tabId: string, chosen: ChatChosen) => void;
  addChatPeerSubmission: (
    workspaceId: string,
    tabId: string,
    id: string,
    submission: PeerSubmission,
  ) => void;
  addChatRelayed: (workspaceId: string, tabId: string, record: RelayedMessage) => void;
  setLimitResume: (workspaceId: string, tabId: string, record: LimitResume | undefined) => void;
  setChatAttachments: (workspaceId: string, tabId: string, attachments: ChatAttachments) => void;
  setCodexThread: (workspaceId: string, tabId: string, threadId: string) => void;
  setChatProfile: (workspaceId: string, tabId: string, profileId: string | undefined) => void;
}

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
  if (args.type === "note") return args.props.title?.trim() || i18next.t("notes:panel.untitled");
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

function terminalTitle(index: number): string {
  return index === 1
    ? i18next.t("common:terminal.default_title")
    : i18next.t("common:terminal.numbered_title", { index });
}

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

function withTab(
  state: TabsState,
  workspaceId: string,
  tabId: string,
  change: (tab: Tab) => Tab,
): Pick<TabsState, "byWorkspace"> {
  const wsRecord = state.byWorkspace[workspaceId];
  const tab = wsRecord?.[tabId];
  if (!wsRecord || !tab) return state;
  const next = change(tab);
  if (next === tab) return state;
  return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...wsRecord, [tabId]: next } } };
}

export const useTabsStore = create<TabsState>((set, get) => {
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
        ...((args.type === "terminal" || args.type === "claude" || args.type === "codex") &&
        args.props.openedBy
          ? { openedAt: performance.timeOrigin + performance.now() }
          : {}),
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
      } else if (args.type === "note") {
        tab = { ...base, type: "note", props: args.props };
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
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          const trimmed = title.trim();
          const nextCustom = trimmed === "" ? undefined : trimmed;
          const nextDisplay = computeDisplayTitle({
            defaultTitle: tab.defaultTitle,
            customTitle: nextCustom,
            processTitle: tab.processTitle,
          });
          if (nextCustom === tab.customTitle && nextDisplay === tab.title) return tab;
          return { ...tab, customTitle: nextCustom, title: nextDisplay };
        }),
      );
    },

    setProcessTitle(workspaceId, tabId, title) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          const trimmed = title === null ? "" : title.trim();
          const nextProcess = trimmed === "" ? undefined : trimmed;
          const nextDisplay = computeDisplayTitle({
            defaultTitle: tab.defaultTitle,
            customTitle: tab.customTitle,
            processTitle: nextProcess,
          });
          if (nextProcess === tab.processTitle && nextDisplay === tab.title) return tab;
          return { ...tab, processTitle: nextProcess, title: nextDisplay };
        }),
      );
    },

    setTerminalDead(workspaceId, tabId, dead) {
      const existingTab = get().byWorkspace[workspaceId]?.[tabId];
      const shouldRecordDeath = existingTab?.type === "terminal" && !existingTab.props.dead && dead;
      const shouldReleaseDeath =
        existingTab?.type === "terminal" && Boolean(existingTab.props.dead) && !dead;

      set((state) =>
        withTab(state, workspaceId, tabId, (tab) =>
          tab.type !== "terminal" || Boolean(tab.props.dead) === dead
            ? tab
            : { ...tab, props: { ...tab.props, dead } },
        ),
      );

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
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) =>
          tab.isPreview ? { ...tab, isPreview: false } : tab,
        ),
      );
    },

    replacePreviewTab(workspaceId, tabId, props, title) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "editor") return tab;
          return {
            ...tab,
            props,
            title,
            defaultTitle: title,
            customTitle: undefined,
            processTitle: undefined,
            isPreview: true,
          };
        }),
      );
    },

    retargetEditorTab(workspaceId, tabId, filePath) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "editor" || tab.props.filePath === filePath) return tab;
          const nextDefault = defaultTitle({ type: "editor", props: { ...tab.props, filePath } });
          return {
            ...tab,
            props: { ...tab.props, filePath },
            defaultTitle: nextDefault,
            title: computeDisplayTitle({
              defaultTitle: nextDefault,
              customTitle: tab.customTitle,
              processTitle: tab.processTitle,
            }),
          };
        }),
      );
    },

    retargetWorkingDiffTab(workspaceId, tabId, relPath) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "editor.diff" || tab.props.rightRef !== "WORKING") return tab;
          if (tab.props.relPath === relPath) return tab;
          const props = { ...tab.props, relPath };
          const nextDefault = defaultTitle({ type: "editor.diff", props });
          return {
            ...tab,
            props,
            defaultTitle: nextDefault,
            title: computeDisplayTitle({
              defaultTitle: nextDefault,
              customTitle: tab.customTitle,
              processTitle: tab.processTitle,
            }),
          };
        }),
      );
    },

    replaceDiffPreviewTab(workspaceId, tabId, props, title) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "editor.diff") return tab;
          return {
            ...tab,
            props,
            title,
            defaultTitle: title,
            customTitle: undefined,
            processTitle: undefined,
            isPreview: true,
          };
        }),
      );
    },

    replaceCommitPreviewTab(workspaceId, tabId, sha, title) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "git.commit") return tab;
          return {
            ...tab,
            props: { workspaceId, sha },
            title,
            defaultTitle: title,
            customTitle: undefined,
            processTitle: undefined,
            isPreview: true,
          };
        }),
      );
    },

    setViewMode(workspaceId, tabId, mode) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) =>
          tab.type !== "editor" || tab.viewMode === mode ? tab : { ...tab, viewMode: mode },
        ),
      );
    },

    replaceUntitledWithEditor(workspaceId, tabId, props, title) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "untitled") return tab;
          return {
            id: tab.id,
            title,
            defaultTitle: title,
            isPreview: tab.isPreview,
            isPinned: tab.isPinned,
            type: "editor",
            props,
          };
        }),
      );
    },

    setCodexThread(workspaceId, tabId, threadId) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "codex") return tab;
          if (tab.props.threadId === threadId && !tab.props.fork) return tab;
          const { fork: _copied, ...props } = tab.props;
          return { ...tab, props: { ...props, threadId } };
        }),
      );
    },

    setChatProfile(workspaceId, tabId, profileId) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          if (tab.props.profileId === profileId) return tab;
          const props = {
            cwd: tab.props.cwd,
            ...(tab.props.openedBy ? { openedBy: tab.props.openedBy } : {}),
            ...(tab.props.instructions !== undefined
              ? { instructions: tab.props.instructions }
              : {}),
            ...(profileId ? { profileId } : {}),
            ...(tab.props.relayed ? { relayed: tab.props.relayed } : {}),
            ...(tab.props.fromApp ? { fromApp: tab.props.fromApp } : {}),
            ...(tab.props.peerSubmissions ? { peerSubmissions: tab.props.peerSubmissions } : {}),
            ...(tab.type === "claude" && tab.props.chosen ? { chosen: tab.props.chosen } : {}),
          };
          return { ...tab, props } as Tab;
        }),
      );
    },

    setClaudeSession(workspaceId, tabId, sessionId) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude") return tab;
          if (tab.props.sessionId === sessionId && !tab.props.fork) return tab;
          const { fork: _copied, ...kept } = tab.props;
          return { ...tab, props: { ...kept, sessionId } };
        }),
      );
    },

    setClaudeTarget(workspaceId, tabId, { sessionId, fork }) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude") return tab;
          const { sessionId: _oldSession, fork: _oldFork, ...kept } = tab.props;
          return {
            ...tab,
            props: { ...kept, ...(sessionId ? { sessionId } : {}), ...(fork ? { fork } : {}) },
          };
        }),
      );
    },

    setChatMoves(workspaceId, tabId, moves) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          if (moves.length === 0 && !tab.props.moves) return tab;
          const { moves: _old, ...rest } = tab.props;
          const props =
            moves.length > 0 ? { ...rest, moves: moves.slice(-PROFILE_MOVES_KEPT) } : rest;
          return { ...tab, props } as Tab;
        }),
      );
    },

    setChatInstructions(workspaceId, tabId, instructions) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          if (tab.props.instructions === instructions) return tab;
          return { ...tab, props: { ...tab.props, instructions } } as Tab;
        }),
      );
    },

    setChatChosen(workspaceId, tabId, chosen) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          const before = tab.props.chosen;
          const empty = !chosen.model && !chosen.effort;
          if (empty) {
            if (!before) return tab;
            const { chosen: _forgotten, ...props } = tab.props;
            return { ...tab, props } as Tab;
          }
          const merged = { ...before, ...chosen };
          const same = merged.model === before?.model && merged.effort === before?.effort;
          return same ? tab : ({ ...tab, props: { ...tab.props, chosen: merged } } as Tab);
        }),
      );
    },

    addChatPeerSubmission(workspaceId, tabId, id, submission) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          const recent = Object.entries(tab.props.peerSubmissions ?? {}).slice(
            1 - MAX_CHAT_PEER_SUBMISSIONS,
          );
          const peerSubmissions = { ...Object.fromEntries(recent), [id]: submission };
          return { ...tab, props: { ...tab.props, peerSubmissions } } as Tab;
        }),
      );
    },

    addChatRelayed(workspaceId, tabId, record) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          if (record.from.kind === "app") {
            const { from: _app, ...message } = record;
            const kept = (tab.props.fromApp ?? []).filter((m) => m.id !== message.id);
            const fromApp = [...kept, message].slice(-RELAYED_KEPT);
            return { ...tab, props: { ...tab.props, fromApp } } as Tab;
          }
          const relayed = withRelayedMessage(tab.props.relayed, record);
          return { ...tab, props: { ...tab.props, relayed } } as Tab;
        }),
      );
    },

    setLimitResume(workspaceId, tabId, record) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          if (tab.props.limitResume === record) return tab;
          const { limitResume: _was, ...props } = tab.props;
          return { ...tab, props: record ? { ...props, limitResume: record } : props } as Tab;
        }),
      );
    },

    setChatAttachments(workspaceId, tabId, attachments) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          if (tab.type !== "claude" && tab.type !== "codex") return tab;
          return { ...tab, props: { ...tab.props, attachments } } as Tab;
        }),
      );
    },

    setBrowserLastUrl(workspaceId, tabId, lastUrl) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) =>
          tab.type === "browser" && tab.props.lastUrl !== lastUrl
            ? { ...tab, props: { ...tab.props, lastUrl } }
            : tab,
        ),
      );
    },

    togglePin(workspaceId, tabId) {
      set((state) =>
        withTab(state, workspaceId, tabId, (tab) => {
          const isPinned = !tab.isPinned;
          return { ...tab, isPinned, isPreview: isPinned ? false : tab.isPreview };
        }),
      );
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

interface UntitledCounterState {
  nextByWorkspace: Record<string, number>;
  claimNext: (workspaceId: string) => number;
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
