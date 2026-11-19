// One controller per Claude tab: starts or re-attaches to the tab's program,
// feeds its lines to the chat model, and writes the user's messages,
// control requests and permission answers to it.
//
// Every line, the app's own included, reaches the model as the agent sends
// it back (chat.line), so a live tab and one that replays the log after a
// window reload build the same view.

import { defaultProfileId, isDefaultProfileId } from "../../../../shared/agent-profiles/profiles";
import { type RelayedMessage, type RelaySender, relayedText } from "../../../../shared/chat/relay";
import type { TranscriptPageResult } from "../../../../shared/ipc/contract";
import { createLogger } from "../../../../shared/log/renderer";
import type { ChatChosen, ProfileMove } from "../../../../shared/types/layout";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { registerWorkspaceCleanup } from "../../../state/workspace-cleanup";
import {
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ImageBlock,
  opensTurn,
  type PermissionRequest,
  type UserItem,
} from "../model";
import { planUsageKeyFor, registerPlanSource, wantPlanUsage } from "../plan-usage";
import { lastMessageId, sameProfile, withMove } from "../profile-moves";
import {
  type ChatTabState,
  type CommandCard,
  chatKey,
  emptyTabState,
  useChatStore,
} from "../store";
import { LiveLines } from "../transport/live-lines";
import { ProgramStartup, stopChatProgram } from "../transport/program-startup";
import {
  clearObservedQueued,
  dispatchQueuedMessage,
  isChatWriteRejected,
  type QueuedMessage,
} from "../transport/queue";
import { addLineReceiver } from "../transport/receivers";
import { backgroundIdOf } from "./command-data";
import {
  configUsageOf,
  LISTED_KEYS_STORAGE,
  type ListedKey,
  parseConfigUsage,
  savedListedKeys,
  withListedKeys,
} from "./config";
import {
  type HistoryCut,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  subagentIdOf,
  subagentLog,
  transcriptGoal,
  uuidBefore,
  withSubagentLog,
} from "./history";
import { effortToApply, remoteAtStartup } from "./settings-defaults";
import { applyLines, endGoal } from "./stream-model";
import { TranscriptPages } from "./transcript-pages";
import { isSupportedClaude, supportsControl, usageSkipsBehaviors } from "./versions";

const log = createLogger("chat");

/** How long a control request waits for its answer. */
const CONTROL_TIMEOUT_MS = 15_000;
/** How long a side question may take: one turn of the model, retries included. */
const SIDE_QUESTION_TIMEOUT_MS = 180_000;
/** The most of the first message Claude names the conversation from. */
const TITLE_FROM_CHARS = 2_000;

/** Longest a replay's lines, sent as events, may trail its answer. */
const REPLAY_CATCH_UP_MS = 3_000;
/** Longest one of Claude Code's own commands (/config) is waited on before the next is sent. */
const COMMAND_DONE_MS = 10_000;
/**
 * How long after a turn ends with the goal set the transcript is read for
 * how the goal stands, and read once more after that: Claude Code writes
 * the check that ended the turn as the turn ends.
 */
const GOAL_SYNC_MS = [500, 2_500];
/** How long clearing the goal waits for the turn it stops to end. */
const GOAL_STOP_MS = 10_000;

/**
 * What a bare /config lists, for each workspace's profile and Claude Code
 * version: asked of the CLI once a run of the app (a run of a second or
 * two), and again after a failure. The answer is kept in localStorage too,
 * which the dialog shows at once while this is asked.
 */
const listedConfigKeys = new Map<string, Promise<ListedKey[] | null>>();

/** How long an ask for the plan's usage (a request to Anthropic's servers) is waited on. */
const USAGE_TIMEOUT_MS = 60_000;

/** How long after a failed ask for the context it is asked once more. */
const CONTEXT_RETRY_MS = 3_000;
/**
 * MCP servers said to be none may still be coming up: for a few seconds
 * after the program's initialize, its servers' list is empty. Asked again
 * this long after, at most MCP_EMPTY_ASKS times a run of the program, as a
 * session can have none.
 */
const MCP_EMPTY_RETRY_MS = 2_000;
const MCP_EMPTY_ASKS = 4;

interface TranscriptSource {
  sessionId: string;
  profileId?: string;
  cut?: HistoryCut;
  title?: string;
  /** The live log kept after the agent that held it was replaced. */
  appended?: ChatModel;
}

interface ReplayResult {
  found: boolean;
  running: boolean;
  truncated: boolean;
  /** The last line the replay sent. */
  lastSeq: number;
}

/** What the side panel asks the CLI for, by the request that tells it. */
const PANEL_REQUESTS = {
  context: "get_context_usage",
  usage: "get_usage",
  mcp: "mcp_status",
} as const;

export type PanelPart = keyof typeof PANEL_REQUESTS;

/** A session to copy, up to and including a message (all of it without one). */
export interface ForkPoint {
  sessionId: string;
  at?: string;
  /** The name the copy takes once it is a session of its own (/branch). */
  title?: string;
  /**
   * The profile that keeps the session, where it is not the tab's: one the
   * tab went on with in another profile, or took up from another's list.
   */
  profileId?: string;
}

export interface ChatTabTarget {
  workspaceId: string;
  tabId: string;
  cwd: string;
  /** The session the tab had, to go on with when its program is gone. */
  sessionId?: string;
  /** The session the tab's program copies, until the copy has its own id. */
  fork?: ForkPoint;
  /** The agent profile its program runs with; absent = the default. */
  profileId?: string;
  /** Where the conversation went on in another profile. */
  moves?: readonly ProfileMove[];
  /** The model and effort the user picked in the tab before. */
  chosen?: ChatChosen;
}

export interface ChatTabHooks {
  /** The session id the tab now has, to keep with the tab. */
  onSession?: (sessionId: string) => void;
  /** A rewind moved the tab to a new start: a fork, or no session at all. */
  onTarget?: (target: { sessionId?: string; fork?: ForkPoint }) => void;
  /** The first message of the conversation, for the tab's title. */
  onFirstMessage?: (text: string) => void;
  /** The title Claude made for the conversation, to take the first message's place. */
  onTitle?: (title: string) => void;
  /**
   * The session's name, as the user gave it: by /rename, by renaming the
   * tab, or one it had when it was taken up again. The tab is called by it.
   */
  onRename?: (title: string) => void;
  /**
   * The tab runs with another profile now: the user switched it, or went on
   * with its conversation in that one.
   */
  onProfile?: (profileId: string) => void;
  /** Where the conversation went on in another profile; none for a new one. */
  onMoves?: (moves: readonly ProfileMove[]) => void;
  /** Who sent a message another agent sent through the nexus command, by its id. */
  onRelayed?: (record: RelayedMessage) => void;
  /** The model or effort the user picked, for the tab to keep. */
  onChosen?: (chosen: ChatChosen) => void;
  onPeerWritten?: (id: string) => void;
}

/** What `rewind_files` would change, or why it cannot. */
export interface RewindPreview {
  canRewind: boolean;
  error?: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

interface StartArgs {
  resume?: string;
  fork?: boolean;
  resumeAt?: string;
  /** Drop the tab's log first: a rewind starts the conversation over. */
  resetLog?: boolean;
}

export type PermissionAnswer =
  | {
      kind: "allow";
      /** The input the tool runs with, as the user filled it (AskUserQuestion's answers). */
      updatedInput?: Record<string, unknown>;
      /** Rules or a mode the allow brings with it (ExitPlanMode's accept-edits). */
      updatedPermissions?: unknown[];
    }
  | {
      kind: "allow-always";
      /** The rules or modes to add, of those the request suggests; all of them when left out. */
      suggestions?: unknown[];
    }
  | { kind: "deny"; message?: string }
  | { kind: "deny-stop"; message?: string };

interface PendingControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let requestCounter = 0;

/** Ids no earlier run of the app has used, so a replayed log does not match them. */
function nextRequestId(): string {
  requestCounter += 1;
  return `app-${Date.now().toString(36)}-${requestCounter}`;
}

export class ChatController {
  readonly key: string;
  private target: ChatTabTarget;
  private hooks: ChatTabHooks;
  /** The flag settings the tab's commands set (/add-dir, /sandbox, the effort picked). */
  private flags: Record<string, unknown> = {};
  /** The model picked in the tab, which a program started again for it takes too. */
  private chosenModel: string | undefined;
  /**
   * The permission mode the tab's program last had, which one started
   * again for it (a rewind, a restart, another profile) goes on in: the
   * settings' default mode is for a new conversation. Not kept past this
   * run of the app, so the tab's first program in the next starts as the
   * settings say.
   */
  private lastMode: string | undefined;
  /** How many times the user picked a mode, which a program starting then takes over its last one's. */
  private modePicks = 0;
  /** A started program's initialize, and the flags given again after it. */
  private changingSession = false;
  private initializing: Promise<void> = Promise.resolve();
  private readonly startup = new ProgramStartup(() =>
    stopChatProgram(this.target.workspaceId, this.target.tabId),
  );
  /** How many times this run of the program said it had no MCP servers, and was asked again. */
  private mcpEmptyAsks = 0;
  private buffered: ChatLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** New lines held while the log is sent again. */
  private readonly live = new LiveLines();
  private readonly pending = new Map<string, PendingControl>();
  private opening: Promise<void> | null = null;
  /** While opening: resolves once the conversation is shown, perhaps before its program is ready. */
  private shown: Promise<void> | null = null;
  private disposed = false;
  private transcriptSource: TranscriptSource | undefined;
  private transcriptPages: TranscriptPages | undefined;
  private earlierHistoryUnknown = false;
  private liveGoalChanged = false;
  private fullTranscript: Promise<void> | undefined;
  /** Public pages and watches use complete history and its original item keys. */
  private publicHistory = false;
  private titled = false;
  /** Subagents whose file is being read (loadSubagent), and those found nowhere. */
  private subagentsReading = new Set<string>();
  private subagentsMissing = new Set<string>();
  /** The tab as a source of its profile's plan usage, taken away as it closes. */
  private readonly leavePlanUsage: () => void;
  private readonly removeReceiver?: () => void;
  /** Whether the program's initialize is still on its way: until then it is asked nothing else. */
  private initPending = false;
  /** The name the program last said its session has. */
  private sessionName: string | undefined;
  private sessionId: string | undefined;
  /**
   * A name the user gave the tab before its conversation began: the session
   * takes it once it has an id. Until then there is no session to name.
   */
  private pendingName: string | undefined;
  /** Whether the session was given a name, which Claude's title from the first message would replace. */
  private named = false;
  /**
   * The name the user gave the tab: every session the tab has takes it, a
   * new one after /clear or another profile too, and Remote Control is told
   * it again as it starts, which can name the session on its own (the
   * computer's name and two words). Another session's message from this one
   * goes under the name Remote Control has.
   */
  private ownName: string | undefined;

  /** The profile the tab's program runs with, for a tab made from it to keep. */
  get profileId(): string {
    return this.target.profileId ?? defaultProfileId("claude");
  }

  /**
   * What a tab made from this one (a fork, /branch) starts with: its
   * profile, and the model and effort picked in it.
   */
  inherited(): { profileId: string; chosen?: ChatChosen } {
    const effort = typeof this.flags.effortLevel === "string" ? this.flags.effortLevel : undefined;
    const chosen: ChatChosen = {
      ...(this.chosenModel ? { model: this.chosenModel } : {}),
      ...(effort ? { effort } : {}),
    };
    return {
      profileId: this.profileId,
      ...(chosen.model || chosen.effort ? { chosen } : {}),
    };
  }

  constructor(
    target: ChatTabTarget,
    hooks: ChatTabHooks = {},
    { receiveAgentEvents = false }: { receiveAgentEvents?: boolean } = {},
  ) {
    this.target = target;
    this.hooks = hooks;
    this.key = chatKey(target.workspaceId, target.tabId);
    if (receiveAgentEvents) this.removeReceiver = addLineReceiver(this, true);
    this.sessionId = target.sessionId;
    this.chosenModel = target.chosen?.model;
    if (target.chosen?.effort) this.flags = { effortLevel: target.chosen.effort };
    this.leavePlanUsage = registerPlanSource({
      agent: "claude",
      usageKey: () => this.usageKey(),
      ready: () => this.lineCanAsk() && !this.initPending && this.supports("get_usage"),
      busy: () => this.state.model.running,
      fetchUsage: () => this.request("get_usage", this.panelParams("usage"), USAGE_TIMEOUT_MS),
    });
  }

  /** The profile whose plan usage the tab shows: its agent, host and profile. */
  usageKey(): string {
    return planUsageKeyFor("claude", this.target.workspaceId, this.target.profileId);
  }

  get state(): ChatTabState {
    return useChatStore.getState().tabs[this.key] ?? emptyTabState();
  }

  setHooks(hooks: ChatTabHooks): void {
    this.hooks = hooks;
  }

  private update(update: (prev: ChatTabState) => ChatTabState): void {
    if (this.disposed) return;
    useChatStore.getState().update(this.key, update);
  }

  /** Shows the tab's conversation: the agent's log, else a new or resumed program. */
  open(): Promise<void> {
    if (this.opening) return this.opening;
    let show = () => {};
    this.shown = new Promise((resolve) => {
      show = resolve;
    });
    this.opening = this.doOpen(show).finally(() => {
      this.opening = null;
      this.shown = null;
      show();
    });
    return this.opening;
  }

  /**
   * Opens the tab as open does, but comes back once its conversation is
   * shown: the transcript read, while a program started on it may still be
   * starting. Another device reading the chat sees it without waiting.
   */
  async openToRead(waitForProgram = false): Promise<void> {
    this.publicHistory = true;
    if (this.opening || this.state.phase === "idle") {
      const opening = this.open();
      await (!waitForProgram && this.shown ? Promise.race([opening, this.shown]) : opening);
    }
    await this.completeTranscript();
  }

  private async doOpen(shown: () => void): Promise<void> {
    if (this.startup.failed) {
      shown();
      await this.start(this.startArgs());
      return;
    }
    this.flushNow();
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined, model: emptyModel() }));
    let replay: ReplayResult;
    try {
      replay = await this.replay();
    } catch (err) {
      this.update((prev) => ({ ...prev, phase: "failed", error: (err as Error).message }));
      return;
    }
    if (replay.found) {
      this.titled = this.titled || this.state.model.items.some((item) => item.kind === "user");
      this.update((prev) => ({
        ...prev,
        phase: replay.running ? "ready" : "ended",
        truncated: replay.truncated,
      }));
      // A program started on a session logs only what came after; the rest
      // is in the transcript.
      if (this.state.model.resumed) await this.loadResumedHistory();
      // A goal met while no window looked on.
      if (!this.state.model.running) void this.syncGoal(!this.publicHistory);
      shown();
      return;
    }
    // The agent has no log: a new tab, or one whose agent restarted.
    if (this.target.fork) {
      const fork = this.target.fork;
      await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile());
    } else if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
    }
    shown();
    await this.start(this.startArgs());
  }

  /** How the tab's program starts again: copying its fork, else going on with its session. */
  private startArgs(): StartArgs {
    const fork = this.target.fork;
    if (fork) return { resume: fork.sessionId, fork: true, resumeAt: fork.at };
    return this.sessionId ? { resume: this.sessionId } : {};
  }

  /** The history before a resumed program's log, from the transcript. */
  private async loadResumedHistory(): Promise<void> {
    const model = this.state.model;
    if (model.sessionId) {
      // A fork's transcript copies the messages it starts from, uuids and all.
      await this.loadTranscript(model.sessionId, { before: modelUuids(model) });
    } else if (this.target.fork) {
      const fork = this.target.fork;
      await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile());
    } else if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
    }
  }

  /**
   * The profile that keeps the session the tab's fork copies, where it is
   * not the tab's own; undefined when it is.
   */
  private forkProfile(): string | undefined {
    const from = this.target.fork?.profileId;
    return from && !sameProfile(from, this.target.profileId) ? from : undefined;
  }

  private transcriptArgs({ sessionId, profileId }: TranscriptSource) {
    return { workspaceId: this.target.workspaceId, sessionId, ...profileArg(profileId) };
  }

  private async loadTranscript(
    sessionId: string,
    cut?: HistoryCut,
    profileId = this.target.profileId,
  ): Promise<void> {
    this.resetTranscript();
    const fork = this.target.fork;
    const source = {
      sessionId,
      profileId,
      cut,
      title: fork?.sessionId === sessionId ? fork.title : undefined,
    };
    this.transcriptSource = source;
    const args = this.transcriptArgs(source);
    try {
      if (this.publicHistory) {
        await this.readFullTranscript(source);
        return;
      }
      const page = unwrapIpcResult(
        await ipcCallResult("chat", "transcriptPage", {
          ...args,
          upTo: cut?.upTo,
          before: cut?.before ? [...cut.before] : undefined,
        }),
      );
      if (this.disposed || this.transcriptSource !== source || !page.found) return;
      if (page.snapshot) {
        const pages = new TranscriptPages(page, page.snapshot);
        this.transcriptPages = pages;
        const current = () =>
          !this.disposed && this.transcriptSource === source && this.transcriptPages === pages;
        let history: ChatModel | undefined;
        try {
          history = await this.readTranscriptBatch(source, pages, current, "opening");
        } finally {
          if (current()) {
            this.publishTranscript(
              source,
              history ?? pages.project(),
              pages.lines,
              pages.truncated,
              true,
            );
          }
        }
      } else {
        this.publishTranscript(
          source,
          historyModel(page.lines, cut),
          page.lines,
          page.truncated,
          true,
        );
      }
    } catch (error) {
      log.warn(`transcript of ${sessionId} not read: ${(error as Error).message}`);
    }
  }

  private async readFullTranscript(
    source: TranscriptSource,
    legacy?: TranscriptPageResult,
  ): Promise<void> {
    const result =
      legacy ??
      unwrapIpcResult(await ipcCallResult("chat", "transcript", this.transcriptArgs(source)));
    if (this.disposed || this.transcriptSource !== source) return;
    if (!result.found && this.transcriptPages)
      throw new Error("The transcript is no longer available");
    if (!result.found) return;
    const live = source.appended ?? this.state.model;
    const before =
      this.transcriptPages &&
      !source.cut &&
      (source.appended || live.sessionId === source.sessionId)
        ? modelUuids(live)
        : undefined;
    const history = historyModel(
      result.lines,
      source.cut ?? (before?.size ? { before } : undefined),
    );
    this.transcriptPages = undefined;
    this.publishTranscript(source, history, result.lines, result.truncated, true);
  }

  private completeTranscript(): Promise<void> | undefined {
    if (this.fullTranscript) return this.fullTranscript;
    const source = this.transcriptSource;
    if (!source || !this.transcriptPages) return;
    const read = this.readFullTranscript(source).finally(() => {
      if (this.fullTranscript === read) this.fullTranscript = undefined;
    });
    this.fullTranscript = read;
    return read;
  }

  /** A click or first open reads a meaningful part of the transcript, across fragment frames. */
  private async readTranscriptBatch(
    source: TranscriptSource,
    pages: TranscriptPages,
    current: () => boolean,
    action: "opening" | "earlier",
    pageRead = action === "opening",
  ): Promise<ChatModel | undefined> {
    const args = this.transcriptArgs(source);
    const requested = new Set<string>();
    const shownFirst = this.state.history?.items[0]?.key;
    while (current()) {
      const cursor = pages.cursor;
      if (!pages.hasPartialRow && pageRead) {
        const read = pages.project();
        const first = read.items[0];
        const enough =
          action === "opening"
            ? read.items.some(opensTurn)
            : first !== undefined && first.key !== shownFirst && opensTurn(first);
        if (enough || !cursor) return read;
      }
      if (!cursor || requested.has(cursor))
        throw new Error("The transcript cursor did not advance");
      requested.add(cursor);
      const result = await ipcCallResult("chat", "transcriptPage", { ...args, cursor });
      if (!current()) return;
      if (!result.ok && result.kind === "chat.transcript-cursor-stale") {
        pages.expireCursor();
        return;
      }
      pages.prepend(unwrapIpcResult(result));
      pageRead = true;
    }
  }

  async loadEarlier(): Promise<void> {
    const source = this.transcriptSource;
    const visible = this.transcriptPages;
    if (!source || !visible?.hasEarlier || this.state.historyPage?.loading) return;
    const current = () =>
      !this.disposed &&
      !this.changingSession &&
      this.transcriptSource === source &&
      this.transcriptPages === visible;
    this.update((prev) => ({ ...prev, historyPage: { hasEarlier: true, loading: true } }));
    try {
      let pages = visible.copy();
      let history = pages.cursor
        ? await this.readTranscriptBatch(source, pages, current, "earlier")
        : undefined;
      if (!current()) return;
      if (pages.cursorExpired) {
        visible.expireCursor();
        const page = visible.beforeAnchor
          ? unwrapIpcResult(
              await ipcCallResult("chat", "transcriptPage", {
                ...this.transcriptArgs(source),
                beforeAnchor: visible.beforeAnchor,
              }),
            )
          : undefined;
        if (!current()) return;
        if (!page?.anchored || !page.snapshot) {
          await this.readFullTranscript(source, page?.found && !page.snapshot ? page : undefined);
          return;
        }
        pages = new TranscriptPages(page, page.snapshot, visible);
        history = await this.readTranscriptBatch(source, pages, current, "earlier", true);
      }
      if (current() && history) {
        this.transcriptPages = pages;
        this.publishTranscript(source, history, pages.lines, pages.truncated, false);
      }
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (this.transcriptPages === visible && this.transcriptSource === source) {
        this.update((prev) => ({
          ...prev,
          historyPage: { hasEarlier: visible.hasEarlier, loading: false },
        }));
      }
    }
  }

  private publishTranscript(
    source: TranscriptSource,
    projected: ChatModel,
    lines: readonly unknown[],
    truncated: boolean,
    initial: boolean,
  ): void {
    const pages = this.transcriptPages;
    this.earlierHistoryUnknown = truncated || pages?.hasEarlier === true;
    const read = source.appended
      ? { ...joinHistory(projected, source.appended), goal: projected.goal }
      : projected;
    // A task's end the log tells too is the log's: it has no uuid to cut at.
    const told = new Set(
      this.state.model.items.flatMap((item) => (item.kind === "task_end" ? [item.key] : [])),
    );
    const history =
      told.size > 0 ? { ...read, items: read.items.filter((item) => !told.has(item.key)) } : read;
    const title = source.title ?? (source.cut ? undefined : sessionTitleOf(lines));
    if (!this.titled && title) {
      this.titled = true;
      this.hooks.onTitle?.(title);
    } else if (!this.titled && (!pages || !this.earlierHistoryUnknown)) {
      const first = history.items.find((item) => item.kind === "user" && item.text.trim());
      if (first?.kind === "user") {
        this.titled = true;
        this.hooks.onFirstMessage?.(first.text.trim());
      }
    }
    this.update((prev) => {
      const agentItems = { ...history.agentItems, ...prev.history?.agentItems };
      return {
        ...prev,
        history:
          history.items.length > 0 || Object.keys(agentItems).length > 0
            ? { ...history, agentItems }
            : null,
        historyPage: pages ? { hasEarlier: pages.hasEarlier, loading: false } : undefined,
        // A previously unread page must not replace a goal that the live log set or cleared.
        model:
          (initial || !prev.history?.goal) &&
          !this.liveGoalChanged &&
          prev.model.goal === undefined &&
          history.goal
            ? { ...prev.model, goal: history.goal }
            : prev.model,
      };
    });
  }

  private resetTranscript(): void {
    this.transcriptSource = undefined;
    this.transcriptPages = undefined;
    this.fullTranscript = undefined;
    this.earlierHistoryUnknown = false;
    this.liveGoalChanged = false;
    if (this.state.historyPage) this.update((prev) => ({ ...prev, historyPage: undefined }));
  }

  /**
   * Reads the messages of a subagent that ended, where the tab has none of
   * them: Claude Code keeps them apart from the session's transcript, so a
   * conversation read from it shows only the subagent's call. They go in the
   * history, where the pane and another device reading the chat find them.
   * One being read, or found nowhere, is not asked for again.
   */
  async loadSubagent(toolUseId: string): Promise<void> {
    if (this.subagentsReading.has(toolUseId) || this.subagentsMissing.has(toolUseId)) return;
    const { history, model } = this.state;
    if (model.agentItems[toolUseId] || history?.agentItems[toolUseId]) return;
    const call = model.tools[toolUseId] ?? history?.tools[toolUseId];
    if (!call || call.status === "running" || call.status === "streaming") return;
    this.subagentsReading.add(toolUseId);
    try {
      if (!(await this.readSubagent(toolUseId, subagentIdOf(call)))) {
        this.subagentsMissing.add(toolUseId);
      }
    } finally {
      this.subagentsReading.delete(toolUseId);
    }
  }

  private async readSubagent(toolUseId: string, agentId: string | undefined): Promise<boolean> {
    const { model } = this.state;
    // Its session's, or, for one a fork copied, the session the fork is of.
    const fork = this.target.fork;
    const places: { sessionId: string; profileId?: string }[] = [];
    for (const sessionId of [model.sessionId, this.sessionId]) {
      if (sessionId && !places.some((place) => place.sessionId === sessionId)) {
        places.push({ sessionId, profileId: this.target.profileId });
      }
    }
    if (fork && !places.some((place) => place.sessionId === fork.sessionId)) {
      places.push({
        sessionId: fork.sessionId,
        profileId: this.forkProfile() ?? this.target.profileId,
      });
    }
    for (const place of places) {
      try {
        const result = unwrapIpcResult(
          await ipcCallResult("chat", "subagentTranscript", {
            workspaceId: this.target.workspaceId,
            sessionId: place.sessionId,
            ...(agentId ? { agentId } : {}),
            toolUseId,
            ...profileArg(place.profileId),
          }),
        );
        if (!result.found) continue;
        const read = subagentLog(result.lines, toolUseId);
        this.update((prev) => ({
          ...prev,
          history: withSubagentLog(prev.history, toolUseId, read),
        }));
        return true;
      } catch (err) {
        log.warn(`subagent ${toolUseId} of ${place.sessionId} not read: ${(err as Error).message}`);
      }
    }
    return false;
  }

  /** Starts and initializes a program before allowing tab input. */
  private start(resume: StartArgs): Promise<boolean> {
    return this.startup.run(() => this.startProgram(resume));
  }

  /** Spawns Claude and applies the tab's settings after its required initialize. */
  private async startProgram(resume: StartArgs): Promise<boolean> {
    if (this.disposed) return false;
    const { workspaceId, tabId, cwd } = this.target;
    // Before the new program's initialize tells the mode it starts in.
    const mode = this.lastMode;
    const picks = this.modePicks;
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined }));
    let result: Awaited<ReturnType<typeof startChat>>;
    try {
      await this.startup.prepare();
      const args = await this.fromAnotherProfile(resume);
      if (this.disposed) return false;
      result = await startChat({
        workspaceId,
        tabId,
        cwd,
        ...args,
        ...profileArg(this.target.profileId),
      });
    } catch (err) {
      this.update((prev) => ({ ...prev, phase: "failed", error: (err as Error).message }));
      return false;
    }
    if (this.disposed) return false;
    if (!result.ok) {
      this.update((prev) => ({
        ...prev,
        phase: result.reason === "not-found" ? "not-found" : "failed",
        error: result.message,
      }));
      return false;
    }
    if (!isSupportedClaude(result.version)) {
      this.update((prev) => ({ ...prev, version: result.version }));
      return this.rejectStartup("old-version");
    }
    this.update((prev) => ({ ...prev, version: result.version }));
    if (resume.resetLog && result.attached) {
      return this.rejectStartup("Claude attached to the previous program");
    }
    if (!result.attached) {
      // Subagents' text comes as messages under their Agent call, for the agent strip.
      let remote = false;
      let started: unknown;
      this.initPending = true;
      const initialized = this.request("initialize", { hooks: null, forwardSubagentText: true })
        .then((init) => {
          remote = remoteAtStartup(init);
          started = init.current_permission_mode;
          // The settings' effort failing leaves the tab's own flags and pick to apply.
          return this.followSettings().catch((err: Error) =>
            log.warn(`settings' effort not applied: ${err.message}`),
          );
        })
        // What /add-dir, /sandbox and the tab's chips set holds for the tab,
        // not one program: after the settings' defaults, which it overrides.
        // One refused leaves the rest, Remote Control included, to go on.
        .then(() => {
          if (Object.keys(this.flags).length === 0) return;
          return this.request("apply_flag_settings", { settings: this.flags }).then(
            () => {},
            (err: Error) => log.warn(`tab settings not applied: ${err.message}`),
          );
        })
        .then(() => {
          if (!this.chosenModel) return;
          return this.request("set_model", { model: this.chosenModel }).then(
            () => {},
            (err: Error) => log.warn(`picked model not applied: ${err.message}`),
          );
        })
        .then(() => {
          // The program before went on in a mode the settings' default would
          // drop; one the user picked as this one started holds instead.
          if (!mode || mode === started || this.modePicks !== picks) return;
          return this.request("set_permission_mode", { mode }).then(
            () => {},
            (err: Error) => log.warn(`mode ${mode} not given again: ${err.message}`),
          );
        })
        .then(() => {
          // Remote Control "at startup" (/config) is the host's to turn on in a headless run.
          if (remote) {
            return this.request("remote_control", { enabled: true }).then(
              () => this.retellName(),
              (err: Error) => log.warn(`remote control not started: ${err.message}`),
            );
          }
        })
        .then(
          () => true,
          (err: Error) => this.rejectStartup(err.message),
        )
        .finally(() => {
          this.initPending = false;
        });
      this.initializing = initialized.then(() => undefined);
      if (!(await initialized)) return false;
    }
    if (this.disposed) return false;
    this.flushNow();
    if (this.state.model.process === "exited")
      return this.rejectStartup("Claude exited during startup");
    this.startup.failed = false;
    this.update((prev) => ({ ...prev, phase: "ready" }));
    return true;
  }

  /** Records the failure and keeps the tab available for a fresh startup. */
  private async rejectStartup(message: string): Promise<false> {
    if (this.disposed) return false;
    log.warn(`Claude startup failed: ${message}`);
    try {
      await this.startup.reject();
    } catch (error) {
      log.warn(`Claude startup cleanup failed: ${(error as Error).message}`);
    }
    this.flushNow();
    this.update((prev) => ({ ...prev, phase: "failed", error: message }));
    return false;
  }

  /**
   * A fork of a session another profile keeps starts from its file there:
   * `claude --resume <file> --fork-session` copies it into the tab's
   * profile, name and all, and leaves it as it was. Remote Control's record
   * of the old session stays behind, so the copy gets its own.
   */
  private async fromAnotherProfile(resume: StartArgs): Promise<StartArgs> {
    const from = this.forkProfile();
    if (!resume.fork || !resume.resume || from === undefined) return resume;
    const file = unwrapIpcResult(
      await ipcCallResult("chat", "sessionFile", {
        workspaceId: this.target.workspaceId,
        sessionId: resume.resume,
        ...profileArg(from),
      }),
    );
    if (!file.found || !file.path) {
      throw new Error(`session ${resume.resume} is not in the profile that kept it`);
    }
    return { ...resume, resume: file.path };
  }

  /**
   * Has a started program run as the user's settings say: `claude -p`
   * leaves their effort out, which it is given here. The answer also tells
   * the tab the model the settings set, before the first turn names it.
   */
  private async followSettings(): Promise<void> {
    if (!this.supports("get_settings")) return;
    const effort = effortToApply(await this.request("get_settings", {}).catch(() => null));
    if (effort && this.supports("apply_flag_settings")) {
      await this.request("apply_flag_settings", { settings: { effortLevel: effort } });
    }
  }

  /** Starts the program again, going on with the session. */
  async restart(): Promise<void> {
    if (this.changingSession) throw new Error("Claude is changing the conversation");
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    await this.start(this.startArgs());
  }

  /** The session the tab goes on with, once it has its own. */
  currentSession(): string | undefined {
    return this.sessionId;
  }

  /** Where a fork from a message starts: after it (Claude's), or before it (the user's). */
  forkPoint(uuid: string, { before }: { before: boolean }): ForkPoint | null {
    const sessionId = this.sessionId ?? this.target.fork?.sessionId;
    if (!sessionId) return null;
    if (!before) return { sessionId, at: uuid };
    const at = uuidBefore(joinHistory(this.state.history, this.state.model), uuid);
    if (!at && this.earlierHistoryUnknown) {
      throw new Error("Read earlier messages before using this point");
    }
    return at ? { sessionId, at } : null;
  }

  /** The oldest visible message has no verified predecessor yet. */
  unverifiedHistoryStart(): string | undefined {
    if (!this.earlierHistoryUnknown) return;
    const { history, model } = this.state;
    for (const items of [history?.items ?? [], model.items]) {
      for (const item of items) {
        if ((item.kind === "user" || item.kind === "assistant") && item.uuid) return item.uuid;
      }
    }
  }

  /** What rewinding the files to before a message would change. */
  async previewRewind(uuid: string): Promise<RewindPreview> {
    this.forkPoint(uuid, { before: true });
    if (!(await this.ensureRunning())) throw new Error("the program is not running");
    return rewindOf(await this.request("rewind_files", { user_message_id: uuid, dry_run: true }));
  }

  /**
   * Goes back to before one of the user's messages, in this tab: the files
   * first when asked, then the conversation, by a program that copies the
   * session up to the message before it. The message goes back in the
   * composer, unless another device asked (`draft` false): it goes back in that one's.
   */
  async rewind(
    item: UserItem,
    { files, draft = true }: { files: boolean; draft?: boolean },
  ): Promise<void> {
    const uuid = item.uuid;
    if (!uuid) throw new Error("the message has no uuid yet");
    if (this.state.model.running) throw new Error("a turn is running");
    const fork = this.forkPoint(uuid, { before: true }) ?? undefined;
    const incomplete = this.earlierHistoryUnknown;
    if (files) {
      if (!(await this.ensureRunning())) throw new Error("the program is not running");
      const result = rewindOf(await this.request("rewind_files", { user_message_id: uuid }));
      if (!result.canRewind) throw new Error(result.error ?? "the files were not rewound");
    }
    const all = joinHistory(this.state.history, this.state.model);
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    this.resetTranscript();
    this.sessionId = undefined;
    this.target = { ...this.target, sessionId: undefined, fork };
    this.hooks.onTarget?.(fork ? { fork } : {});
    const kept = modelBefore(all, uuid);
    this.update((prev) => ({
      ...prev,
      history: kept.items.length > 0 ? kept : null,
      // The old program's last lines stay out of sight until the log starts over.
      model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
      ...(draft ? { draft: { text: item.text, images: item.images, nonce: Date.now() } } : {}),
    }));
    if (incomplete && fork)
      await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile());
    if (await this.start({ ...this.startArgs(), resetLog: true })) await this.rebuild();
  }

  /**
   * Goes on with another session of the folder in this tab, which has no
   * conversation yet: its program starts over on that session. One another
   * profile keeps is copied into the tab's (`--fork-session`), name and all,
   * and left as it was there.
   */
  async resumeSession(sessionId: string, profileId?: string): Promise<void> {
    if (this.state.model.running) throw new Error("a turn is running");
    await this.changeSession(async () => {
      const from =
        profileId !== undefined && !sameProfile(profileId, this.target.profileId)
          ? profileId
          : undefined;
      const fork: ForkPoint | undefined = from ? { sessionId, profileId: from } : undefined;
      this.sessionId = fork ? undefined : sessionId;
      this.sessionName = undefined;
      this.target = { ...this.target, sessionId: this.sessionId, fork, moves: undefined };
      this.titled = false;
      this.pendingName = undefined;
      this.named = false;
      this.update((prev) => ({
        ...prev,
        history: null,
        card: undefined,
        model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
      }));
      await this.loadTranscript(sessionId, undefined, from);
      await this.startChangedSession(this.startArgs());
      this.publishSessionTarget();
      this.hooks.onMoves?.([]);
    });
  }

  /**
   * Starts this tab over in a new conversation with another profile: its
   * program stops, a turn under way with it, and the session it had is
   * left as it was, for the old profile to go on with.
   */
  async switchProfile(profileId: string): Promise<void> {
    if (sameProfile(profileId, this.target.profileId)) return;
    await this.changeSession(async () => {
      this.sessionId = undefined;
      this.sessionName = undefined;
      this.target = {
        ...this.target,
        sessionId: undefined,
        fork: undefined,
        profileId: isDefaultProfileId(profileId) ? undefined : profileId,
        moves: undefined,
      };
      this.titled = false;
      this.update((prev) => ({
        ...prev,
        history: null,
        queue: [],
        card: undefined,
        model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
      }));
      await this.startChangedSession({});
      this.hooks.onProfile?.(profileId);
      this.hooks.onTitle?.(this.sessionName ?? "");
      this.publishSessionTarget();
    });
  }

  /** Waits for a confirmed stop before changing the session and its profile. */
  private async changeSession(change: (shown: number) => Promise<void>): Promise<void> {
    if (
      this.disposed ||
      this.changingSession ||
      this.startup.pending ||
      this.state.queue.some((item) => item.status === "sending")
    ) {
      throw new Error("Claude is changing the conversation");
    }
    this.changingSession = true;
    try {
      this.flushNow();
      const shown = this.state.model.items.length;
      if (this.state.model.process === "running") {
        await stopChatProgram(this.target.workspaceId, this.target.tabId);
      }
      this.flushNow();
      if (this.disposed) throw new Error("the tab closed");
      const source = this.state;
      const transcriptSource = this.transcriptSource;
      const transcriptPages = this.transcriptPages;
      const earlierHistoryUnknown = this.earlierHistoryUnknown;
      const liveGoalChanged = this.liveGoalChanged;
      const target = this.target;
      const sessionId = this.sessionId;
      const sessionName = this.sessionName;
      const titled = this.titled;
      const pendingName = this.pendingName;
      const named = this.named;
      const lastMode = this.lastMode;
      this.resetTranscript();
      try {
        await change(shown);
      } catch (error) {
        this.resetTranscript();
        this.transcriptSource = transcriptSource && { ...transcriptSource };
        this.transcriptPages = transcriptPages;
        this.earlierHistoryUnknown = earlierHistoryUnknown;
        this.liveGoalChanged = liveGoalChanged;
        this.target = target;
        this.sessionId = sessionId;
        this.sessionName = sessionName;
        this.titled = titled;
        this.pendingName = pendingName;
        this.named = named;
        this.lastMode = lastMode;
        this.startup.failed = true;
        this.update((prev) => ({
          ...source,
          historyPage: source.historyPage && { ...source.historyPage, loading: false },
          phase: "failed",
          error: (error as Error).message,
          model: {
            ...source.model,
            lastSeq: Math.max(source.model.lastSeq, prev.model.lastSeq),
            process: "exited",
            running: false,
            turn: null,
            permissions: [],
          },
        }));
        throw error;
      }
    } finally {
      this.changingSession = false;
    }
  }

  /** Starts the proposed session and reports failure before tab metadata is saved. */
  private async startChangedSession(args: StartArgs): Promise<void> {
    if (!(await this.start({ ...args, resetLog: true }))) {
      throw new Error(this.state.error ?? "Claude could not start the requested session");
    }
  }

  /** Persists the session the replacement actually established or is forking. */
  private publishSessionTarget(): void {
    const fork = this.target.fork;
    if (fork) this.hooks.onTarget?.({ fork });
    else if (this.sessionId) this.hooks.onTarget?.({ sessionId: this.sessionId });
  }

  /**
   * Goes on with this tab's conversation in another profile: its program
   * stops, a turn under way with it, and one of the new profile's copies the
   * session, its name too (`--resume <file> --fork-session`). The session is
   * left as it was, for the old profile to go on with. A tab with no
   * conversation yet just switches.
   */
  async continueInProfile(profileId: string): Promise<void> {
    if (sameProfile(profileId, this.target.profileId)) return;
    const pending = this.target.fork;
    const sessionId = this.sessionId ?? pending?.sessionId;
    if (!sessionId) {
      await this.switchProfile(profileId);
      return;
    }
    await this.completeTranscript();
    await this.changeSession(async (shown) => {
      // The program stopped here told of its exit; the conversation goes on.
      const model = this.state.model;
      const items = model.items.filter(
        (item, i) => i < shown || !(item.kind === "notice" && item.code === "exited"),
      );
      const joined = joinHistory(this.state.history, { ...model, items });
      const all = { ...emptyModel(), items: joined.items, tools: joined.tools };
      // A copy that has no id of its own yet is copied from where it copies.
      const fork: ForkPoint =
        this.sessionId === undefined && pending
          ? { ...pending, profileId: pending.profileId ?? this.profileId }
          : { sessionId, profileId: this.profileId };
      const after = lastMessageId(all.items);
      const moves = after
        ? withMove(this.target.moves, { profileId, after, at: Date.now() })
        : [...(this.target.moves ?? [])];
      this.sessionId = undefined;
      this.sessionName = undefined;
      this.target = {
        ...this.target,
        sessionId: undefined,
        fork,
        profileId: isDefaultProfileId(profileId) ? undefined : profileId,
        moves,
      };
      this.update((prev) => ({
        ...prev,
        history: all.items.length > 0 ? all : null,
        queue: [],
        card: undefined,
        model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
      }));
      await this.startChangedSession(this.startArgs());
      this.hooks.onProfile?.(profileId);
      this.publishSessionTarget();
      this.hooks.onMoves?.(moves);
    });
  }

  /**
   * Names the tab's session, as /rename does: its program is started for it
   * when it is not running. A tab with no conversation yet keeps the name
   * for the session it starts, in place of the title Claude makes from the
   * first message. False when the session cannot be named now: it has no
   * conversation yet, or its version cannot.
   */
  async renameSession(title: string): Promise<boolean> {
    const name = title.trim();
    if (!name) return false;
    this.named = true;
    const sessionId = this.state.model.sessionId ?? this.sessionId;
    if (!sessionId) {
      this.pendingName = name;
      return false;
    }
    this.pendingName = undefined;
    // The tab took the name from the session: it has it already.
    if (name === this.sessionName) return true;
    if (!(await this.ensureRunning()) || !this.supports("rename_session")) return false;
    await this.request("rename_session", {
      title: name,
      // The user's own rename, for the session it was made on.
      source: "host",
      session_id: sessionId,
    });
    return true;
  }

  /** Takes the name the user gave the tab, or none, for the sessions it has from now. */
  keepName(title: string | undefined): void {
    this.ownName = title?.trim() || undefined;
  }

  /**
   * Tells the session the tab's name again, though it has it: Remote Control,
   * just started, can have named the session on its own.
   */
  private retellName(): void {
    const sessionId = this.state.model.sessionId ?? this.sessionId;
    if (!this.ownName || !sessionId || !this.supports("rename_session")) return;
    void this.request("rename_session", {
      title: this.ownName,
      source: "host",
      session_id: sessionId,
    }).catch(() => {});
  }

  /** Builds the model again from the agent's log, which a rewind started over. */
  private async rebuild(): Promise<void> {
    this.flushNow();
    this.update((prev) => ({ ...prev, model: emptyModel() }));
    try {
      await this.replay();
    } catch (err) {
      log.warn(`replay after a rewind failed: ${(err as Error).message}`);
    }
    this.flushNow();
  }

  /**
   * Has the agent send the tab's log again (after `afterSeq`) and waits for
   * its lines; new lines that come meanwhile are taken after them.
   */
  private async replay(afterSeq?: number): Promise<ReplayResult> {
    const { workspaceId, tabId } = this.target;
    this.live.hold();
    try {
      const replay = unwrapIpcResult(
        await ipcCallResult("chat", "replay", {
          workspaceId,
          tabId,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
        }),
      );
      await this.catchUp(replay);
      return replay;
    } finally {
      const held = this.live.release();
      if (held.length > 0 && !this.disposed) {
        this.buffered.push(...held);
        this.flushNow();
      }
    }
  }

  /** Waits for a replay's lines, which come as events and may trail its answer. */
  private async catchUp(replay: ReplayResult): Promise<void> {
    this.flushNow();
    if (!replay.found) return;
    const deadline = Date.now() + REPLAY_CATCH_UP_MS;
    while (this.state.model.lastSeq < replay.lastSeq && !this.disposed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      this.flushNow();
    }
  }

  /** The agent is back: replay what the tab missed, or find its program gone. */
  async resync(): Promise<void> {
    this.flushNow();
    const source = this.transcriptSource;
    let replay: ReplayResult;
    try {
      replay = await this.replay(this.state.model.lastSeq);
    } catch {
      return;
    }
    if (this.disposed || this.changingSession || this.transcriptSource !== source) return;
    if (replay.found) {
      this.update((prev) => ({ ...prev, phase: replay.running ? "ready" : "ended" }));
      return;
    }
    // A new agent: what the tab showed becomes its history. Its cursor died with the old agent.
    const pages = this.transcriptPages;
    if (!pages && this.opening) return;
    if (source && pages) {
      this.fullTranscript = undefined;
      this.transcriptSource = {
        ...source,
        appended: joinHistory(source.appended ?? null, this.state.model),
      };
      pages.expireCursor();
    } else {
      const earlierHistoryUnknown = this.earlierHistoryUnknown;
      this.resetTranscript();
      this.earlierHistoryUnknown = earlierHistoryUnknown;
    }
    this.update((prev) => ({
      ...prev,
      phase: "ended",
      history: joinHistory(prev.history, prev.model),
      historyPage: pages ? { hasEarlier: pages.hasEarlier, loading: false } : undefined,
      model: emptyModel(),
    }));
    this.rejectPending("the program is gone");
  }

  held(): void {
    this.update((prev) => (prev.phase === "ready" ? { ...prev, phase: "held" } : prev));
  }

  /**
   * Starts the program when it is not running and takes in what it has said
   * so far: what the tab shows then is all the conversation had before one
   * more message.
   */
  async prepareSend(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    this.flushNow();
  }

  /** Sends a message now: during a turn, Claude reads it after the current tool. */
  /**
   * Sends a message. One another agent sends through the nexus command
   * (`from`) is led by a line that tells Claude who sent it.
   */
  send(text: string, images: ImageBlock[] = [], from?: RelaySender, id?: string): Promise<void> {
    return this.sendMessage(text, images, false, from, id);
  }

  /**
   * Sends a message Claude reads at once (⌘↩): during a turn, what Claude
   * runs that can go on in the background goes there, and the turn stops
   * for the message when nothing can.
   */
  sendNow(text: string, images: ImageBlock[] = [], from?: RelaySender, id?: string): Promise<void> {
    return this.sendMessage(text, images, true, from, id);
  }

  /**
   * Has Claude read at once the messages it holds for after its tool calls
   * (⌘↩ with nothing typed): the calls go on in the background, or the
   * turn stops when none can, and Claude reads the messages next.
   */
  async readHeldNow(): Promise<void> {
    if (this.supports("background_tasks")) {
      const result = await this.request("background_tasks", {}).catch(() => undefined);
      if (result && result.backgrounded !== false) return;
    }
    await this.interrupt();
  }

  /**
   * Takes back a message written during the turn that Claude has not read
   * (↑, or its pencil or ×): true when Claude dropped it, false when it was
   * read first. The lifecycle event that tells the drop takes it off the list.
   */
  async withdraw(sentUuid: string): Promise<boolean> {
    const result = await this.request("cancel_async_message", { message_uuid: sentUuid });
    return result.cancelled === true;
  }

  private async sendMessage(
    text: string,
    images: ImageBlock[],
    now: boolean,
    from?: RelaySender,
    id?: string,
    queued = false,
  ): Promise<undefined> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    // A program just started takes the tab's flags and pick first, so its
    // first turn runs with them. The chain settles on its own failures.
    await this.initializing;
    if (this.changingSession) throw new Error("Claude is changing the conversation");
    if (queued && !this.state.queue.some((entry) => entry.id === id && entry.status === "sending"))
      throw new Error("The conversation changed while delivering a queued message");
    const first = !this.titled && text.trim() ? text.trim() : undefined;
    if (first) {
      this.titled = true;
      this.hooks.onFirstMessage?.(first);
    }
    const message = userMessageOf(from ? relayedText(from, text) : text, images, now, id);
    // Kept before Claude echoes it, so it never shows as the user's.
    if (from) this.hooks.onRelayed?.({ id: String(message.uuid), from, at: Date.now() });
    await this.write(message);
    this.flushNow();
    if (id) this.hooks.onPeerWritten?.(id);
    // A session the user named, or the tab, keeps that name; Claude makes it none.
    if (first && !this.named && !this.ownName) void this.nameSession(first);
  }

  /**
   * Has Claude name the conversation from its first message, as the terminal
   * does: the title is kept in the session, where a later tab finds it.
   */
  private async nameSession(text: string): Promise<void> {
    const result = await this.request("generate_session_title", {
      description: text.slice(0, TITLE_FROM_CHARS),
      persist: true,
    }).catch(() => undefined);
    const title = typeof result?.title === "string" ? result.title.trim() : "";
    if (title) this.hooks.onTitle?.(title);
  }

  /** The composer took the message a rewind or fork put back. */
  clearDraft(): void {
    this.update((prev) => (prev.draft ? { ...prev, draft: undefined } : prev));
  }

  /**
   * Holds a message until the turn ends (⌘⇧↩): its id while it is held,
   * none when no turn runs and it went at once.
   */
  enqueue(
    text: string,
    images: ImageBlock[] = [],
    from?: RelaySender,
    device?: string,
    id?: string,
  ): string | undefined {
    const item: QueuedMessage = {
      id: id ?? nextRequestId(),
      text,
      images,
      ...(from ? { from } : {}),
      ...(device ? { device } : {}),
    };
    this.update((prev) => ({ ...prev, queue: [...prev.queue, item] }));
    if (!this.state.model.running) this.sendNextQueued();
    return this.state.queue.some((entry) => entry.id === item.id) ? item.id : undefined;
  }

  removeQueued(id: string): QueuedMessage | undefined {
    const item = this.state.queue.find((q) => q.id === id && q.status !== "sending");
    if (!item) return undefined;
    this.update((prev) => ({ ...prev, queue: prev.queue.filter((q) => q.id !== id) }));
    return item;
  }

  /**
   * Changes a held message's text, its images kept: false once it went.
   * Changed from another computer (`device`), it is that computer user's
   * now, no longer the agent's that sent it.
   */
  editQueued(id: string, text: string, device?: string): boolean {
    if (!this.state.queue.some((q) => q.id === id && !q.status)) return false;
    this.update((prev) => ({
      ...prev,
      queue: prev.queue.map((q) => {
        if (q.id !== id) return q;
        if (!device) return { ...q, text };
        const { from: _agent, ...rest } = q;
        return { ...rest, text, device };
      }),
    }));
    return true;
  }

  private sendNextQueued(): void {
    if (this.changingSession) return;
    dispatchQueuedMessage(
      this.state.queue,
      (update) => this.update(update),
      (next) => this.sendMessage(next.text, next.images, false, next.from, next.id, true),
      isChatWriteRejected,
      (id) => this.sawQueuedMessage(id),
      () => {
        this.flushNow();
        if (!this.state.model.running) this.sendNextQueued();
      },
    );
  }

  private sawQueuedMessage(id: string): boolean {
    return this.state.model.items.some(
      (item) => item.kind === "user" && item.state === "taken" && item.sentUuid === id,
    );
  }

  /** Interrupts the current turn and releases its controls if the request fails. */
  async interrupt(): Promise<unknown> {
    const requestId = nextRequestId();
    try {
      return await this.request("interrupt", {}, CONTROL_TIMEOUT_MS, requestId);
    } catch (error) {
      this.flushNow();
      this.update((prev) =>
        prev.model.interruptRequestId === requestId
          ? {
              ...prev,
              model: { ...prev.model, interrupting: false, interruptRequestId: undefined },
            }
          : prev,
      );
      throw error;
    }
  }

  setPermissionMode(mode: string): Promise<unknown> {
    this.modePicks += 1;
    return this.shownAtOnce("permissionMode", mode, () =>
      this.request("set_permission_mode", { mode }),
    );
  }

  // A pick Claude Code takes holds for the tab: a program started again for
  // it takes it too. One it refuses is not kept, so no start gives it again.
  setModel(model: string): Promise<unknown> {
    return this.shownAtOnce("model", model, () => this.request("set_model", { model })).then(
      (answer) => {
        this.chosenModel = model;
        this.hooks.onChosen?.({ model });
        return answer;
      },
    );
  }

  setEffort(level: string): Promise<unknown> {
    return this.shownAtOnce("effort", level, () =>
      this.request("apply_flag_settings", { settings: { effortLevel: level } }),
    ).then((answer) => {
      this.flags = { ...this.flags, effortLevel: level };
      this.hooks.onChosen?.({ effort: level });
      return answer;
    });
  }

  /**
   * A setting the user picked, shown at once rather than when Claude Code
   * answers; its answer then says what holds (it may say another mode).
   * One that fails puts back what was shown, unless something has changed
   * it since.
   */
  private shownAtOnce(
    key: "permissionMode" | "model" | "effort",
    value: string,
    send: () => Promise<Record<string, unknown>>,
  ): Promise<unknown> {
    const before = this.state.model[key];
    this.update((prev) => ({ ...prev, model: { ...prev.model, [key]: value } }));
    return send().catch((err: unknown) => {
      if (this.state.model[key] === value) {
        this.update((prev) => ({ ...prev, model: { ...prev.model, [key]: before } }));
      }
      throw err;
    });
  }

  /** Stops one of the CLI's tasks: a subagent, a command in the background. */
  stopTask(taskId: string): Promise<unknown> {
    return this.request("stop_task", { task_id: taskId });
  }

  /**
   * Asks for what the side panel shows that only a request tells: the
   * context, the plan's usage, the MCP servers. Only while the program
   * runs, and the servers once its initialize ended; the answers land in
   * the model.
   */
  refreshPanel(parts: readonly PanelPart[]): void {
    if (!this.lineCanAsk()) return;
    for (const part of parts) {
      if (part === "context") {
        this.refreshContext();
        continue;
      }
      if (part === "usage") {
        // The user opened it: the profile's store asks, sooner than it would.
        // After the program's initialize: asked before it ends, no tab of the
        // profile is ready to ask, and the store leaves it to the next ask.
        void this.initializing
          .catch(() => {})
          .then(() => wantPlanUsage(this.usageKey(), { force: true }));
        continue;
      }
      const subtype = PANEL_REQUESTS[part];
      if (!this.supports(subtype)) continue;
      // After the program's initialize: asked before it ends, the MCP servers
      // are not up yet and come back as none, which the panel would keep.
      void this.initializing.catch(() => {}).then(() => this.askPanel(part, subtype));
    }
  }

  /** Asks for a part of the panel; MCP servers said to be none, again a little later. */
  private askPanel(part: PanelPart, subtype: string): void {
    if (!this.lineCanAsk()) return;
    this.request(subtype, this.panelParams(part))
      .then((body) => {
        const none = part === "mcp" && Array.isArray(body.mcpServers) && !body.mcpServers.length;
        if (!none || this.mcpEmptyAsks >= MCP_EMPTY_ASKS) return;
        this.mcpEmptyAsks += 1;
        setTimeout(() => this.askPanel(part, subtype), MCP_EMPTY_RETRY_MS);
      })
      .catch(() => {});
  }

  /**
   * Asks again for what the line under the composer shows, as the tab is
   * shown or its program comes up: the context, after the program's
   * initialize, which a first ask could otherwise pass; and the profile's
   * plan usage, which its store asks for when it is time.
   */
  refreshUsageLine(): void {
    if (!this.lineCanAsk()) return;
    void this.initializing
      .catch(() => {})
      .then(() => {
        this.refreshContext();
        void wantPlanUsage(this.usageKey());
      });
  }

  private lineCanAsk(): boolean {
    const { phase, model } = this.state;
    return !this.disposed && phase === "ready" && model.process === "running";
  }

  /** What a part of the panel is asked with: the plan's limits alone, where the CLI can. */
  private panelParams(part: PanelPart): Record<string, unknown> {
    const version = this.state.version ?? this.state.model.version;
    return part === "usage" && usageSkipsBehaviors(version) ? { skip_behaviors: true } : {};
  }

  /**
   * The context again: after each turn, the tab shown or not, so the agents
   * tab has it too, and after a compaction. A failed ask is made once more.
   */
  private refreshContext(retry = true): void {
    if (!this.lineCanAsk() || !this.supports(PANEL_REQUESTS.context)) return;
    this.request(PANEL_REQUESTS.context, {}).catch(() => {
      if (retry) setTimeout(() => this.refreshContext(false), CONTEXT_RETRY_MS);
    });
  }

  async mcpReconnect(serverName: string): Promise<void> {
    try {
      await this.request("mcp_reconnect", { serverName });
    } finally {
      // A server that failed to connect again shows how it is now.
      this.refreshPanel(["mcp"]);
    }
  }

  /**
   * Signs in to an MCP server that needs it: Claude Code makes the sign-in
   * page, the browser opens it, and comes back to a page on this machine
   * (main's oauth callbacks) whose address goes back to Claude Code. The
   * server then connects again. It works the same for a program on an SSH
   * host, whose own callback the browser could not reach.
   */
  async mcpAuthenticate(serverName: string): Promise<void> {
    if (this.state.mcpSignIn) this.cancelMcpSignIn();
    const { id, redirectUri } = unwrapIpcResult(await ipcCallResult("chat", "oauthListen", {}));
    try {
      const page = signInPageOf(
        await this.request("mcp_authenticate", { serverName, redirectUri }),
      );
      const authUrl = page.authUrl;
      if (!authUrl) {
        // Signed in already: nothing to open.
        void ipcCallResult("chat", "oauthCancel", { id });
        await this.request("mcp_reconnect", { serverName });
        return;
      }
      if (!page.back) {
        void ipcCallResult("chat", "oauthCancel", { id });
        openSignInPage(authUrl);
        return;
      }
      // Waiting before the browser opens, so a sign-in that comes straight back is not missed.
      const back = ipcCallResult("chat", "oauthWait", { id });
      this.update((prev) => ({ ...prev, mcpSignIn: { serverName, authUrl, callbackId: id } }));
      openSignInPage(authUrl);
      const url = unwrapIpcResult(await back).url;
      if (url === null) return;
      await this.request("mcp_oauth_callback_url", { serverName, callbackUrl: url });
      await this.request("mcp_reconnect", { serverName });
    } catch (err) {
      void ipcCallResult("chat", "oauthCancel", { id });
      throw err;
    } finally {
      this.update((prev) =>
        prev.mcpSignIn?.callbackId === id ? { ...prev, mcpSignIn: undefined } : prev,
      );
      this.refreshPanel(["mcp"]);
    }
  }

  /**
   * Starts signing in to an MCP server with another device's browser, its
   * page coming back to `redirectUri` there: the page to open, none when
   * signed in already (connected again then); `back` when the page comes
   * back there, the address it came back to then going to mcpSignedIn.
   */
  async mcpSignInFor(
    serverName: string,
    redirectUri: string,
  ): Promise<{ authUrl?: string; back: boolean }> {
    const page = signInPageOf(await this.request("mcp_authenticate", { serverName, redirectUri }));
    if (page.authUrl) return page;
    try {
      await this.request("mcp_reconnect", { serverName });
    } finally {
      this.refreshPanel(["mcp"]);
    }
    return { back: false };
  }

  /** Finishes another device's sign-in: the address its page came back to, to Claude Code. */
  async mcpSignedIn(serverName: string, callbackUrl: string): Promise<void> {
    try {
      await this.request("mcp_oauth_callback_url", { serverName, callbackUrl });
      await this.request("mcp_reconnect", { serverName });
    } finally {
      this.refreshPanel(["mcp"]);
    }
  }

  /** Opens the sign-in page under way again. */
  reopenMcpSignIn(): void {
    const signIn = this.state.mcpSignIn;
    if (signIn) openSignInPage(signIn.authUrl);
  }

  /** Stops waiting for the sign-in under way. */
  cancelMcpSignIn(): void {
    const signIn = this.state.mcpSignIn;
    if (!signIn) return;
    void ipcCallResult("chat", "oauthCancel", { id: signIn.callbackId });
    this.update((prev) => ({ ...prev, mcpSignIn: undefined }));
  }

  /**
   * Asks Claude a question beside the conversation (/btw): it sees the
   * conversation, uses no tools, and the question and its answer are not
   * kept in it. Null when there is no answer.
   */
  async askAside(question: string): Promise<string | null> {
    await this.settled();
    const body = await this.request("side_question", { question }, SIDE_QUESTION_TIMEOUT_MS);
    return typeof body.response === "string" ? body.response : null;
  }

  /**
   * Sets settings for the session's flag layer (apply_flag_settings), kept
   * for the tab: a program started again gets them too. A key given
   * replaces what it had (a list of folders is given whole).
   */
  async applyFlags(settings: Record<string, unknown>): Promise<void> {
    await this.settled();
    await this.request("apply_flag_settings", { settings });
    this.flags = { ...this.flags, ...settings };
  }

  /** The folders /add-dir gave the session, beside its own. */
  addedDirectories(): string[] {
    const permissions = this.flags.permissions as { additionalDirectories?: string[] } | undefined;
    return permissions?.additionalDirectories ?? [];
  }

  /**
   * Sends a running command or subagent to the background (Ctrl+B in the
   * terminal): its call returns at once and the turn goes on; it ends as a
   * task of its own.
   */
  async backgroundTool(toolUseId: string): Promise<void> {
    await this.request("background_tasks", { tool_use_id: toolUseId });
  }

  /**
   * Hands the conversation to Claude Code's background service (`claude
   * --bg --resume`), which goes on with it, and with the prompt when there
   * is one; a tab without a session yet sends just the prompt. The tab's
   * own program ends first, so that only one goes on with the session.
   * The background session's id.
   */
  async sendToBackground(prompt: string): Promise<string> {
    const { workspaceId, tabId, cwd } = this.target;
    const { model } = this.state;
    if (model.running) throw new Error("a turn is running");
    const sessionId = this.sessionId;
    if (!sessionId && !prompt) throw new Error("the tab has no conversation yet");
    if (model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    const run = unwrapIpcResult(
      await ipcCallResult("chat", "cli", {
        workspaceId,
        cwd,
        ...profileArg(this.target.profileId),
        command: {
          kind: "background",
          ...(sessionId ? { sessionId } : {}),
          ...(model.model ? { model: model.model } : {}),
          ...(prompt ? { prompt } : {}),
        },
      }),
    );
    const id = backgroundIdOf(run.stdout);
    if (!id) {
      throw new Error(run.stderr.trim() || run.stdout.trim() || "claude --bg did not start");
    }
    return id;
  }

  /** Has a running program load the plugins again, after one was changed. */
  async reloadPlugins(): Promise<void> {
    if (this.state.model.process !== "running" || !this.supports("reload_plugins")) return;
    await this.request("reload_plugins", {});
  }

  /** Starts the program when it is not running, and waits for its initialize. */
  private async settled(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    await this.initializing;
  }

  /** Asks the program now, starting it for the question. */
  async ask(subtype: string): Promise<Record<string, unknown>> {
    await this.settled();
    return this.request(subtype, {});
  }

  /**
   * What the settings dialog (/config) shows: the settings Claude Code has
   * now (get_settings), and those of its global config file on the host,
   * which settings.json may lack; none of the file's when it is not read.
   * The keys come apart: savedConfigKeys at once, listConfigKeys later.
   */
  async readConfig(): Promise<{
    effective: Record<string, unknown>;
    global: Record<string, unknown>;
    /** The model the program runs ("claude-opus-5-5"), whose default effort is shown. */
    model?: string;
  }> {
    const [settings, global] = await Promise.all([
      this.ask("get_settings"),
      ipcCallResult("chat", "claudeConfig", {
        workspaceId: this.target.workspaceId,
        ...profileArg(this.target.profileId),
      })
        .then((result) => unwrapIpcResult(result).values)
        .catch((err: Error) => {
          log.warn(`Claude Code's global config not read: ${err.message}`);
          return {};
        }),
    ]);
    const effective = settings.effective;
    const applied = settings.applied as { model?: unknown } | undefined;
    return {
      effective:
        typeof effective === "object" && effective !== null
          ? (effective as Record<string, unknown>)
          : {},
      global,
      model: typeof applied?.model === "string" ? applied.model : undefined,
    };
  }

  /** Where /config's list is kept for the tab: its workspace's profile, and the version it runs. */
  private configKeysPlace(): { place: string; version: string } {
    const { workspaceId, profileId } = this.target;
    return {
      place: [workspaceId, profileId ?? ""].join("\n"),
      version: this.state.version ?? this.state.model.version ?? "",
    };
  }

  /**
   * The keys a bare /config listed when last asked for the tab's workspace,
   * profile and Claude Code version, in this run of the app or an earlier
   * one; null when they were not.
   */
  savedConfigKeys(): ListedKey[] | null {
    const { place, version } = this.configKeysPlace();
    try {
      return savedListedKeys(localStorage.getItem(LISTED_KEYS_STORAGE), place, version);
    } catch {
      return null;
    }
  }

  /**
   * The keys a bare /config lists, asked of a `claude -p` run beside the
   * tab's (once a run of the app) and kept for savedConfigKeys; null when
   * they were not read.
   */
  listConfigKeys(): Promise<ListedKey[] | null> {
    const { workspaceId, cwd, profileId } = this.target;
    const { place, version } = this.configKeysPlace();
    const key = [place, version].join("\n");
    let listed = listedConfigKeys.get(key);
    if (!listed) {
      listed = ipcCallResult("chat", "cli", {
        workspaceId,
        cwd,
        ...profileArg(profileId),
        command: { kind: "configUsage" },
      })
        .then((result) => {
          const keys = parseConfigUsage(configUsageOf(unwrapIpcResult(result).stdout));
          if (keys.length === 0) throw new Error("no keys in its answer");
          if (version) {
            try {
              const saved = localStorage.getItem(LISTED_KEYS_STORAGE);
              localStorage.setItem(
                LISTED_KEYS_STORAGE,
                withListedKeys(saved, place, version, keys),
              );
            } catch (err) {
              log.warn(`/config's keys not kept: ${(err as Error).message}`);
            }
          }
          return keys;
        })
        .catch((err: Error) => {
          log.warn(`/config's keys not listed: ${err.message}`);
          listedConfigKeys.delete(key);
          return null;
        });
      listedConfigKeys.set(key, listed);
    }
    return listed;
  }

  /**
   * Applies the settings dialog's changes: its /config messages, which save
   * the defaults (and switch the session to a new default model), then the
   * default effort, saved for the model the session runs as Claude Code's
   * /effort saves it. The tab's own chips take both, as the CLI's session
   * does.
   */
  async applyConfig(
    messages: readonly string[],
    after: { model?: string; effort?: string } = {},
  ): Promise<void> {
    await this.sendCommands(messages, true);
    if (after.model) await this.setModel(after.model);
    if (after.effort) {
      await this.request("update_settings", {
        source: "userSettings",
        settings: { effortLevel: after.effort },
      });
      await this.setEffort(after.effort);
    }
  }

  /**
   * Sends Claude Code's own commands as messages (/config key=value),
   * which it runs without the model: unlike a message, they do not name
   * the conversation. Each goes once the one before is done, so that it
   * is not taken for a message waiting on a turn.
   */
  async sendCommands(texts: readonly string[], waitForLast = false): Promise<void> {
    for (const [index, text] of texts.entries()) {
      if (!(await this.ensureRunning())) throw new Error("Claude is not running");
      const message = userMessageOf(text, []);
      await this.write(message);
      if (waitForLast || index < texts.length - 1) {
        await this.commandDone(message.uuid as string);
      }
    }
  }

  /** Waits for a command sent to be done: its turn ended, or a while. */
  private async commandDone(uuid: string): Promise<void> {
    const deadline = Date.now() + COMMAND_DONE_MS;
    while (!this.disposed && Date.now() < deadline) {
      this.flushNow();
      const { running, items } = this.state.model;
      if (!running && items.some((item) => item.kind === "user" && item.sentUuid === uuid)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Reads in the session's transcript how its goal stands, while the tab
   * has it running: a check that finds it met, or impossible, ends the
   * turn, and only the transcript says so.
   */
  private async syncGoal(latestPage = false): Promise<void> {
    const sessionId = this.state.model.sessionId ?? this.sessionId;
    if (this.disposed || this.state.model.goal?.status !== "active" || !sessionId) return;
    try {
      const result = unwrapIpcResult(
        await ipcCallResult("chat", latestPage ? "transcriptPage" : "transcript", {
          workspaceId: this.target.workspaceId,
          sessionId,
          ...profileArg(this.target.profileId),
        }),
      );
      const told = result.found ? transcriptGoal(result.lines) : undefined;
      if (!told || told.status === "active") return;
      this.update((prev) => {
        const model = endGoal(prev.model, told);
        return model === prev.model ? prev : { ...prev, model };
      });
    } catch (err) {
      log.warn(`goal of ${sessionId} not read: ${(err as Error).message}`);
    }
  }

  /**
   * Clears the goal (/goal clear). Claude Code runs the command once the
   * turn ends, which a goal holds off until it is met: the turn stops first.
   */
  async clearGoal(): Promise<void> {
    if (this.state.model.running) {
      await this.interrupt().catch(() => {});
      const deadline = Date.now() + GOAL_STOP_MS;
      while (!this.disposed && this.state.model.running && Date.now() < deadline) {
        this.flushNow();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await this.sendCommands(["/goal clear"], true);
  }

  /** Shows a card above the composer, in place of the one before; its id, to fill it in. */
  showCard(card: Omit<CommandCard, "id">): string {
    const id = nextRequestId();
    this.update((prev) => ({ ...prev, card: { ...card, id } }));
    return id;
  }

  /** Fills in a card that is still shown. */
  updateCard(id: string, patch: Partial<Omit<CommandCard, "id">>): void {
    this.update((prev) =>
      prev.card?.id === id ? { ...prev, card: { ...prev.card, ...patch } } : prev,
    );
  }

  closeCard(): void {
    this.update((prev) => (prev.card ? { ...prev, card: undefined } : prev));
  }

  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    try {
      await this.request("mcp_toggle", { serverName, enabled });
    } finally {
      this.refreshPanel(["mcp"]);
    }
  }

  /**
   * The CLI's suggestions for an @-mention, as its own prompt lists them:
   * paths relative to the session's folder, or absolute; a folder ends in
   * a separator. None while the program does not run.
   */
  async fileSuggestions(query: string): Promise<string[]> {
    const { phase, model } = this.state;
    if (phase !== "ready" || model.process !== "running") return [];
    if (!this.supports("file_suggestions")) return [];
    const body = await this.request("file_suggestions", { query });
    if (!Array.isArray(body.suggestions)) return [];
    return body.suggestions.flatMap((raw) => {
      const path = (raw as { path?: unknown } | null)?.path;
      return typeof path === "string" && path ? [path] : [];
    });
  }

  /**
   * Writes a file attached to a message where the program can read it,
   * and returns its path there.
   */
  async attach(name: string, data: string): Promise<string> {
    const { workspaceId, tabId } = this.target;
    const result = unwrapIpcResult(
      await ipcCallResult("chat", "attach", { workspaceId, tabId, name, data }),
    );
    return result.path;
  }

  /** Turns Remote Control on or off; on, its answer has the session's URL. */
  setRemoteControl(enabled: boolean): Promise<unknown> {
    return this.request("remote_control", { enabled }).then((answer) => {
      if (enabled) this.retellName();
      return answer;
    });
  }

  supports(subtype: string): boolean {
    return supportsControl(this.state.version ?? this.state.model.version, subtype);
  }

  async answerPermission(request: PermissionRequest, answer: PermissionAnswer): Promise<void> {
    let body: Record<string, unknown>;
    switch (answer.kind) {
      case "allow":
        body = {
          behavior: "allow",
          updatedInput: answer.updatedInput ?? request.input,
          ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
        };
        break;
      case "allow-always":
        body = {
          behavior: "allow",
          updatedInput: request.input,
          updatedPermissions: answer.suggestions ?? request.suggestions,
        };
        break;
      case "deny":
        body = { behavior: "deny", message: answer.message || "The user denied this." };
        break;
      case "deny-stop":
        body = {
          behavior: "deny",
          message: answer.message || "The user denied this.",
          interrupt: true,
        };
        break;
    }
    await this.write({
      type: "control_response",
      response: { subtype: "success", request_id: request.requestId, response: body },
    });
    // The session's status, from its hooks, waits on the dialog until the
    // call ends: told now that none is open.
    const open = this.state.model.permissions.some((p) => p.requestId !== request.requestId);
    if (!open) {
      const { workspaceId, tabId } = this.target;
      const stopped = answer.kind === "deny-stop";
      ipcCallResult("claude", "answeredInChat", { workspaceId, tabId, stopped }).catch(
        (err: Error) => log.warn(`answer not told: ${err.message}`),
      );
    }
  }

  /** Sends a control request and waits for its answer. */
  request(
    subtype: string,
    params: Record<string, unknown>,
    timeoutMs = CONTROL_TIMEOUT_MS,
    id = nextRequestId(),
  ): Promise<Record<string, unknown>> {
    if (!this.supports(subtype)) {
      return Promise.reject(new Error(`${subtype} needs a newer Claude Code`));
    }
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${subtype} got no answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ type: "control_request", request_id: id, request: { subtype, ...params } }).catch(
      (err: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(err);
      },
    );
    return promise;
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (this.disposed) throw new Error("the tab closed");
    const { workspaceId, tabId } = this.target;
    unwrapIpcResult(await ipcCallResult("chat", "send", { workspaceId, tabId, message }));
  }

  /** Starts the program again when it is not running, for a message to go to. */
  private async ensureRunning(): Promise<boolean> {
    if (this.disposed || this.changingSession) return false;
    if (this.opening) {
      await this.opening;
      if (this.state.phase === "failed") return false;
    }
    if (this.startup.pending) return this.startup.pending;
    const { phase, model } = this.state;
    if (phase === "ready" && model.process === "running") return true;
    if (phase === "held" || phase === "not-found") return false;
    return this.start(this.startArgs());
  }

  /** A line from the agent, buffered for the next frame. */
  receive(line: ChatLine): void {
    if (this.disposed) return;
    if (!line.replay) this.inspectLive(line);
    if (this.live.holds(line)) return;
    this.buffered.push(line);
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flushNow(), 16);
  }

  /** What a live line asks of the controller, beyond the model. */
  private inspectLive(line: ChatLine): void {
    const message = line.message as Record<string, unknown> | undefined;
    if (line.dir !== "out" || !message) return;
    if (message.type === "control_response") {
      const response = message.response as Record<string, unknown> | undefined;
      const id = typeof response?.request_id === "string" ? response.request_id : "";
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (response?.subtype === "error") entry.reject(new Error(String(response.error ?? "error")));
      else entry.resolve((response?.response as Record<string, unknown>) ?? {});
    } else if (
      message.type === "result" ||
      (message.type === "system" && message.subtype === "compact_boundary")
    ) {
      // Each turn's end, whoever began it: the app, a message the CLI took
      // after the last turn, Remote Control, a background task's news. The
      // profile's usage too, which its store asks for when it is time.
      this.refreshContext();
      if (message.type === "result") void wantPlanUsage(this.usageKey());
      if (message.type === "result" && this.state.model.goal?.status === "active") {
        for (const ms of GOAL_SYNC_MS) setTimeout(() => void this.syncGoal(), ms);
      }
    } else if (message.type === "system" && message.subtype === "session_title_changed") {
      // Said when the name changes, and as the program starts on a session
      // that has one; the CLI has trimmed it and made it unique.
      const title = typeof message.title === "string" ? message.title.trim() : "";
      if (title && title !== this.sessionName) {
        this.sessionName = title;
        this.titled = true;
        if (!this.changingSession) this.hooks.onRename?.(title);
      }
    } else if (message.type === "control_request") {
      const request = message.request as Record<string, unknown> | undefined;
      // Requests the app has no answer for are refused, so the CLI does not wait.
      if (request?.subtype !== "can_use_tool" && typeof message.request_id === "string") {
        void this.write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: message.request_id,
            error: `Unsupported control request: ${String(request?.subtype)}`,
          },
        }).catch(() => {});
      }
    }
  }

  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    const before = this.state.model;
    const model = applyLines(before, lines);
    if (model === before) return;
    this.update((prev) => ({
      ...prev,
      model,
      phase: phaseAfter(prev.phase, model),
    }));
    this.afterModel(before, model);
  }

  private afterModel(before: ChatModel, model: ChatModel): void {
    if (before.goal !== model.goal) this.liveGoalChanged = true;
    // The mode the program is in, for one started again in the tab to go on in.
    if (model.permissionMode) this.lastMode = model.permissionMode;
    if (model.sessionId && model.sessionId !== this.sessionId) {
      // The copy a fork made has its own id now: the tab goes on with it,
      // and a branch takes its name.
      // A name the user gave the tab before goes first; the tab's own
      // name names a new session after /clear or another profile.
      const name = this.pendingName ?? this.target.fork?.title ?? this.ownName;
      this.sessionId = model.sessionId;
      this.target = { ...this.target, fork: undefined };
      if (!this.changingSession) {
        this.hooks.onSession?.(model.sessionId);
        if (name) void this.renameSession(name).catch(() => {});
      }
    }
    // What the tab showed before a /clear, a command's card too, is another session's.
    if ((model.clears ?? 0) !== (before.clears ?? 0)) {
      this.resetTranscript();
      this.update((prev) =>
        prev.history || prev.card ? { ...prev, history: null, card: undefined } : prev,
      );
    }
    if (
      model.items !== before.items &&
      this.state.queue.some((item) => item.status === "unconfirmed")
    )
      this.update((prev) => clearObservedQueued(prev, (id) => this.sawQueuedMessage(id)));
    if (before.running && !model.running) this.sendNextQueued();
    if (model.process === "exited" && before.process !== "exited") {
      this.rejectPending("the program exited");
      this.mcpEmptyAsks = 0;
    }
  }

  private rejectPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** The tab was closed: the program ends and its log is forgotten. */
  async close(): Promise<void> {
    const { workspaceId, tabId } = this.target;
    this.dispose();
    await ipcCallResult("chat", "close", { workspaceId, tabId }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.rejectPending("the tab closed");
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.disposed = true;
    this.removeReceiver?.();
    this.leavePlanUsage();
    useChatStore.getState().remove(this.key);
    controllers.delete(this.key);
  }
}

function phaseAfter(phase: ChatTabState["phase"], model: ChatModel): ChatTabState["phase"] {
  if (model.process === "exited" && (phase === "ready" || phase === "held")) return "ended";
  if (model.process === "running" && (phase === "ended" || phase === "held")) return "ready";
  return phase;
}

/** The profile a call names, when the tab has one. */
export function profileArg(profileId: string | undefined): { profileId?: string } {
  return profileId ? { profileId } : {};
}

function startChat(
  args: StartArgs & { workspaceId: string; tabId: string; cwd: string; profileId?: string },
) {
  return ipcCallResult("chat", "start", args).then(unwrapIpcResult);
}

function forkCut(fork: ForkPoint): HistoryCut | undefined {
  return fork.at !== undefined ? { upTo: fork.at } : undefined;
}

function rewindOf(response: Record<string, unknown>): RewindPreview {
  const files = Array.isArray(response.filesChanged) ? response.filesChanged : [];
  return {
    canRewind: response.canRewind === true,
    ...(typeof response.error === "string" ? { error: response.error } : {}),
    filesChanged: files.filter((f): f is string => typeof f === "string"),
    insertions: typeof response.insertions === "number" ? response.insertions : 0,
    deletions: typeof response.deletions === "number" ? response.deletions : 0,
  };
}

// ---------------------------------------------------------------------------
// Registry: one controller per tab, fed by one set of IPC listeners.
// ---------------------------------------------------------------------------

const controllers = new Map<string, ChatController>();

registerWorkspaceCleanup((workspaceId) => {
  const prefix = `${workspaceId}:`;
  for (const [key, controller] of controllers) {
    if (key.startsWith(prefix)) controller.dispose();
  }
});
/** The tab's controller, made on first use. */
const pruned = new Set<string>();
registerWorkspaceCleanup((workspaceId) => pruned.delete(workspaceId));

/**
 * Removes, once per workspace while the app runs, the attached files the
 * agent still keeps for Claude tabs that closed while the app was away.
 */
export function pruneAttachmentsOnce(workspaceId: string, openTabIds: string[]): void {
  if (pruned.has(workspaceId)) return;
  pruned.add(workspaceId);
  void ipcCallResult("chat", "pruneAttachments", { workspaceId, keepTabIds: openTabIds }).catch(
    (err: Error) => {
      pruned.delete(workspaceId);
      log.warn(`pruning attachments failed: ${err.message}`);
    },
  );
}

/** Opens an MCP server's sign-in page in the user's browser, as a link in the tab is. */
function openSignInPage(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * The sign-in page mcp_authenticate gives, none when signed in already;
 * `back` false when nothing comes back to its redirect: a claude.ai
 * connector is connected on claude.ai, and a version that keeps its own
 * callback takes it on the host it runs on.
 */
export function signInPageOf(body: unknown): { authUrl?: string; back: boolean } {
  const reply = body as
    | { authUrl?: unknown; callbackExpected?: unknown; callbackPort?: unknown }
    | undefined;
  const authUrl = typeof reply?.authUrl === "string" ? reply.authUrl : undefined;
  if (!authUrl) return { back: false };
  return {
    authUrl,
    back: !(reply?.callbackExpected === false || typeof reply?.callbackPort === "number"),
  };
}

/** The controller of a Claude tab that was shown, if any: its program and requests. */
export function existingChatController(
  workspaceId: string,
  tabId: string,
): ChatController | undefined {
  return controllers.get(chatKey(workspaceId, tabId));
}

export function chatController(target: ChatTabTarget, hooks?: ChatTabHooks): ChatController {
  const key = chatKey(target.workspaceId, target.tabId);
  let controller = controllers.get(key);
  if (!controller) {
    controller = new ChatController(target, hooks, { receiveAgentEvents: true });
    controllers.set(key, controller);
  } else if (hooks) {
    controller.setHooks(hooks);
  }
  return controller;
}

export function findChatController(workspaceId: string, tabId: string): ChatController | undefined {
  return controllers.get(chatKey(workspaceId, tabId));
}

/** Ends a closed tab's program, whether or not its view was ever shown. */
export function closeChatTab(workspaceId: string, tabId: string): void {
  const controller = controllers.get(chatKey(workspaceId, tabId));
  if (controller) {
    void controller.close();
    return;
  }
  void ipcCallResult("chat", "close", { workspaceId, tabId }).catch(() => {});
}

/**
 * The line that sends the user's message. Its uuid is what Claude's echo
 * and lifecycle events name, and what takes it back while it waits.
 * `now` has Claude read it at once during a turn: sent by a person, it moves
 * what can go on in the background there (Claude Code 2.1.286 on); before
 * that version the turn stops for it. Claude Code acts on `now` only for a
 * message with a uuid (2.1.318).
 */
export function userMessageOf(
  text: string,
  images: readonly ImageBlock[],
  now = false,
  id: string = crypto.randomUUID(),
): Record<string, unknown> {
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          })),
          ...(text ? [{ type: "text", text }] : []),
        ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
    uuid: id,
    ...(now ? { priority: "now", origin: { kind: "human" } } : {}),
  };
}
