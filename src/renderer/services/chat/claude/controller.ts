import i18next from "i18next";
import type { ProfileConnection } from "../../../../shared/agent-profiles/connection";
import {
  defaultProfileId,
  isDefaultProfileId,
  profileOf,
} from "../../../../shared/agent-profiles/profiles";
import { type RelayedMessage, type RelaySender, relayedText } from "../../../../shared/chat/relay";
import type { TranscriptPageResult } from "../../../../shared/ipc/contract";
import { safeText } from "../../../../shared/log/limit";
import { redactLogSecrets } from "../../../../shared/log/redact-secrets";
import { createLogger } from "../../../../shared/log/renderer";
import type { ChatChosen, ProfileMove } from "../../../../shared/types/layout";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
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
import {
  attachToTab,
  editQueuedIn,
  heldTab,
  holdUnread,
  type ReplayResult,
  ResyncRetry,
  removeQueuedIn,
  replayTab,
} from "../tab-core";
import { ConnectionRestart } from "../transport/connection-restart";
import { LiveLines } from "../transport/live-lines";
import { ProgramStartup, stopChatProgram } from "../transport/program-startup";
import {
  clearObservedQueued,
  dispatchQueuedMessage,
  isChatWriteRejected,
  type QueuedMessage,
  unconfirmedMessage,
} from "../transport/queue";
import { addLineReceiver } from "../transport/receivers";
import { backgroundIdOf, sandboxOn } from "./command-data";
import {
  configUsageOf,
  LISTED_KEYS_STORAGE,
  type ListedKey,
  parseConfigUsage,
  savedListedKeys,
  withListedKeys,
} from "./config";
import {
  cutEntries,
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
import { claudeModelCatalogKey, useClaudeModelCatalog } from "./model-catalog";
import { effortToApply, remoteAtStartup } from "./settings-defaults";
import { applyLines, endGoal, mainCallContextTokens } from "./stream-model";
import { TranscriptPages } from "./transcript-pages";
import { isSupportedClaude, supportsControl, usageSkipsBehaviors } from "./versions";

const log = createLogger("chat");

const CONTROL_TIMEOUT_MS = 15_000;
const SIDE_QUESTION_TIMEOUT_MS = 180_000;
const TITLE_FROM_CHARS = 2_000;

const COMMAND_DONE_MS = 10_000;
const GOAL_SYNC_MS = [500, 2_500];
const GOAL_STOP_MS = 10_000;

const listedConfigKeys = new Map<string, Promise<ListedKey[] | null>>();

const USAGE_TIMEOUT_MS = 60_000;

const CONTEXT_RETRY_MS = 3_000;
const MCP_EMPTY_RETRY_MS = 2_000;
const MCP_EMPTY_ASKS = 4;

interface TranscriptSource {
  sessionId: string;
  profileId?: string;
  cut?: HistoryCut;
  title?: string;
  logTruncated?: boolean;
  appended?: ChatModel;
}

const PANEL_REQUESTS = {
  context: "get_context_usage",
  usage: "get_usage",
  mcp: "mcp_status",
} as const;

export type PanelPart = keyof typeof PANEL_REQUESTS;

export interface ForkPoint {
  sessionId: string;
  at?: string;
  title?: string;
  profileId?: string;
}

export interface ChatTabTarget {
  workspaceId: string;
  tabId: string;
  cwd: string;
  sessionId?: string;
  fork?: ForkPoint;
  profileId?: string;
  moves?: readonly ProfileMove[];
  chosen?: ChatChosen;
}

export interface ChatTabHooks {
  instructions?: (sessionId?: string) => string;
  mergedInstructions?: (profileId: string | undefined, session: string) => string;
  onSession?: (sessionId: string) => void;
  onTarget?: (target: { sessionId?: string; fork?: ForkPoint }) => void;
  onFirstMessage?: (text: string) => void;
  onTitle?: (title: string) => void;
  onRename?: (title: string) => void;
  onProfile?: (profileId: string) => void;
  onMoves?: (moves: readonly ProfileMove[]) => void;
  onRelayed?: (record: RelayedMessage) => void;
  relayedFrom?: (id: string) => RelaySender | undefined;
  onChosen?: (chosen: ChatChosen) => void;
  onPeerWritten?: (id: string) => void;
  onTurnEnd?: (model: ChatModel) => void;
}

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
  resetLog?: boolean;
  connectionChanged?: boolean;
}

export type PermissionAnswer =
  | {
      kind: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      kind: "allow-always";
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

function nextRequestId(): string {
  requestCounter += 1;
  return `app-${Date.now().toString(36)}-${requestCounter}`;
}

export class ChatController {
  readonly key: string;
  private target: ChatTabTarget;
  private hooks: ChatTabHooks;
  private launchInstructions: string | undefined;
  private freshPromptSent = false;
  private flags: Record<string, unknown> = {};
  private chosenModel: string | undefined;
  private connection: ProfileConnection | undefined;
  private lastMode: string | undefined;
  private modePicks = 0;
  private changingSession = false;
  private initializing: Promise<void> = Promise.resolve();
  private readonly startup = new ProgramStartup(() =>
    stopChatProgram(this.target.workspaceId, this.target.tabId),
  );
  private writingUserMessage = 0;
  private readonly connectionRestart = new ConnectionRestart(
    (profileId) => {
      if (this.disposed || this.profileId !== profileId) return "skip";
      const { model, phase, queue } = this.state;
      if (
        this.opening ||
        this.startup.pending ||
        this.changingSession ||
        this.writingUserMessage ||
        this.buffered.length ||
        phase === "held" ||
        model.running ||
        model.streaming !== null ||
        Object.values(model.tasks).some((task) => task.status === "running") ||
        queue.some((item) => item.status === "sending")
      )
        return "wait";
      return model.process === "running" ||
        ((phase === "ended" || phase === "failed") && this.sessionId)
        ? "ready"
        : "skip";
    },
    () => this.restartProgram(true),
    () => {
      this.refreshContext();
      this.sendNextQueued();
    },
    (error) => log.warn(`Claude could not restart after a profile edit: ${String(error)}`),
  );
  private readonly resyncRetry = new ResyncRetry(
    () => !this.disposed && this.state.phase === "held",
    () => void this.resync(),
  );
  private mcpEmptyAsks = 0;
  private contextAsks = 0;
  private contextBaseAsked = false;
  private buffered: ChatLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly live = new LiveLines();
  private remoteControlChange: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, PendingControl>();
  private opening: Promise<void> | null = null;
  private shown: Promise<void> | null = null;
  private disposed = false;
  private transcriptSource: TranscriptSource | undefined;
  private transcriptPages: TranscriptPages | undefined;
  private earlierHistoryUnknown = false;
  private liveGoalChanged = false;
  private fullTranscript: Promise<void> | undefined;
  private publicHistory = false;
  private titled = false;
  private subagentsReading = new Set<string>();
  private subagentsMissing = new Set<string>();
  private readonly leavePlanUsage: () => void;
  private readonly removeReceiver?: () => void;
  private initPending = false;
  private sessionName: string | undefined;
  private sessionId: string | undefined;
  private sandboxSessionId = crypto.randomUUID();
  private pendingName: string | undefined;
  private named = false;
  private ownName: string | undefined;

  get profileId(): string {
    return this.target.profileId ?? defaultProfileId("claude");
  }

  get claudeProfileDefaultModel(): string | undefined {
    const connection = this.connection;
    return connection?.method === "custom" ? connection.defaultModel : undefined;
  }

  get modelCatalogKey(): string {
    return claudeModelCatalogKey(this.target.workspaceId, this.target.profileId);
  }

  inherited(): { profileId: string; chosen?: ChatChosen; instructions?: string } {
    const effort = typeof this.flags.effortLevel === "string" ? this.flags.effortLevel : undefined;
    const chosen: ChatChosen = {
      ...(this.chosenModel ? { model: this.chosenModel } : {}),
      ...(effort ? { effort } : {}),
    };
    const instructions = this.hooks.instructions?.(this.sessionId);
    return {
      profileId: this.profileId,
      ...(instructions ? { instructions } : {}),
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
    this.connection = savedProfileConnection(target.profileId);
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
      fetchUsage: () => this.readPlanUsage(),
    });
  }

  static async probePlanUsage(target: Pick<ChatTabTarget, "workspaceId" | "cwd" | "profileId">) {
    const tabId = crypto.randomUUID();
    const controller = new ChatController({ ...target, tabId }, {}, { receiveAgentEvents: true });
    try {
      const result = await startChat({ ...target, tabId, usageOnly: true });
      if (!result.ok) throw new Error(result.message);
      controller.update((prev) => ({ ...prev, version: result.version }));
      if (!controller.supports("get_usage")) throw new Error("get_usage needs a newer Claude Code");
      await controller.request("initialize", { hooks: null });
      return await controller.readPlanUsage();
    } finally {
      await controller.close();
    }
  }

  private readPlanUsage(): Promise<Record<string, unknown>> {
    return this.request("get_usage", this.panelParams("usage"), USAGE_TIMEOUT_MS);
  }

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

  get isOpening(): boolean {
    return this.opening !== null;
  }

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
      const truncated = replay.truncated === true;
      this.earlierHistoryUnknown = truncated;
      this.titled = this.titled || this.state.model.items.some((item) => item.kind === "user");
      this.update((prev) => ({
        ...prev,
        phase: replay.running ? "ready" : "ended",
        truncated,
        model:
          replay.running && prev.model.process !== "running"
            ? { ...prev.model, process: "running" }
            : prev.model,
      }));
      if (truncated || this.state.model.resumed) await this.loadResumedHistory(truncated);
      if (!this.state.model.running) void this.syncGoal(!this.publicHistory);
      shown();
      return;
    }
    if (this.target.fork) {
      const fork = this.target.fork;
      await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile());
    } else if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
    }
    shown();
    await this.start(this.startArgs());
  }

  private startArgs(): StartArgs {
    const fork = this.target.fork;
    if (fork) return { resume: fork.sessionId, fork: true, resumeAt: fork.at };
    return this.sessionId ? { resume: this.sessionId } : {};
  }

  private async loadResumedHistory(logTruncated: boolean): Promise<void> {
    const model = this.state.model;
    const fork = this.target.fork;
    const sessionId = model.sessionId ?? (fork ? undefined : this.sessionId);
    if (sessionId) {
      const uuids = modelUuids(model);
      const first = uuids.values().next().value;
      const before = logTruncated && first ? new Set([first]) : uuids;
      await this.loadTranscript(sessionId, { before }, undefined, logTruncated);
    } else if (fork) {
      await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile(), logTruncated);
    }
  }

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
    logTruncated = false,
  ): Promise<void> {
    this.resetTranscript(logTruncated);
    const fork = this.target.fork;
    const source = {
      sessionId,
      profileId,
      cut,
      logTruncated,
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
      if (logTruncated && cut?.before?.size && page.cutMatched === false) return;
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
              history ?? pages.project(this.liveCompacted()),
              pages.lines,
              pages.truncated,
              true,
            );
          }
        }
      } else await this.readFullTranscript(source, page);
    } catch (error) {
      log.warn(`transcript of ${sessionId} not read: ${(error as Error).message}`);
    }
  }

  private liveCompacted(): boolean {
    const model = this.state.model;
    return [...model.items, ...(this.transcriptSource?.appended?.items ?? [])].some(
      (item) => item.kind === "notice" && item.code === "compacted",
    );
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
    const cut = source.cut ?? (before?.size ? { before } : undefined);
    const entries = cut ? cutEntries(result.lines, cut) : result.lines;
    const cutMatched = !!cut?.before?.size && entries.length < result.lines.length;
    if (source.logTruncated && cut?.before?.size && !cutMatched) {
      if (this.transcriptPages) throw new Error("The transcript no longer joins this conversation");
      return;
    }
    const history = historyModel(entries, undefined, undefined, this.liveCompacted());
    this.transcriptPages = undefined;
    this.publishTranscript(source, history, result.lines, result.truncated, true, cutMatched);
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
        const read = pages.project(this.liveCompacted());
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
    cutMatched = !!source.cut?.before?.size && this.transcriptPages?.cutMatched === true,
  ): void {
    const pages = this.transcriptPages;
    const historyTruncated = truncated || (source.logTruncated === true && !cutMatched);
    this.earlierHistoryUnknown = historyTruncated || pages?.hasEarlier === true;
    const read = source.appended
      ? { ...joinHistory(projected, source.appended), goal: projected.goal }
      : projected;
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
        truncated: historyTruncated,
        history:
          history.items.length > 0 || Object.keys(agentItems).length > 0
            ? { ...history, agentItems }
            : null,
        historyPage: pages ? { hasEarlier: pages.hasEarlier, loading: false } : undefined,
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

  private resetTranscript(truncated = false): void {
    this.transcriptSource = undefined;
    this.transcriptPages = undefined;
    this.fullTranscript = undefined;
    this.earlierHistoryUnknown = truncated;
    this.liveGoalChanged = false;
    if (this.state.historyPage || this.state.truncated !== truncated) {
      this.update((prev) => ({ ...prev, truncated, historyPage: undefined }));
    }
  }

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

  private start(resume: StartArgs): Promise<boolean> {
    return this.startup.run(() => this.startProgram(resume));
  }

  private async startProgram(resume: StartArgs): Promise<boolean> {
    if (this.disposed) return false;
    const { workspaceId, tabId, cwd, profileId } = this.target;
    const connection = savedProfileConnection(profileId);
    const mode = this.lastMode;
    const picks = this.modePicks;
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined }));
    let result: Awaited<ReturnType<typeof startChat>>;
    let launchInstructions: string | undefined;
    try {
      await this.startup.prepare();
      const args = await this.fromAnotherProfile(resume);
      if (this.disposed) return false;
      const instructions = this.hooks.instructions?.(resume.fork ? undefined : this.sessionId);
      launchInstructions =
        !resume.resume && instructions !== undefined
          ? this.hooks.mergedInstructions?.(this.target.profileId, instructions)
          : undefined;
      result = await startChat({
        workspaceId,
        tabId,
        cwd,
        ...args,
        ...profileArg(this.target.profileId),
        ...(instructions === undefined ? {} : { instructions }),
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
    if ((resume.resetLog || resume.connectionChanged) && result.attached) {
      return this.rejectStartup("Claude attached to the previous program");
    }
    this.launchInstructions = result.attached ? undefined : launchInstructions;
    this.freshPromptSent = false;
    if (!result.attached) {
      const previousConnection = this.connection;
      this.connection = connection;
      let remote = false;
      let started: unknown;
      this.initPending = true;
      const initialized = this.request("initialize", {
        hooks: null,
        forwardSubagentText: true,
        ...(resume.resume ? { systemPromptSnapshot: false } : {}),
      })
        .then((init) => {
          remote = remoteAtStartup(init);
          started = init.current_permission_mode;
          return this.followSettings().catch((err: Error) =>
            log.warn(`settings' effort not applied: ${err.message}`),
          );
        })
        .then(() => {
          if (Object.keys(this.flags).length === 0) return;
          return this.request("apply_flag_settings", { settings: this.flags }).then(
            () => {},
            (err: Error) => log.warn(`tab settings not applied: ${err.message}`),
          );
        })
        .then(() => {
          const picked = this.chosenModel;
          if (!picked) return;
          const replacedCustomConnection =
            resume.connectionChanged &&
            previousConnection?.method === "custom" &&
            connection?.method !== "custom";
          if (
            picked !== "default" &&
            (replacedCustomConnection ||
              (connection?.method === "custom" &&
                !connection.models.some(({ id }) => id === picked)))
          ) {
            this.chosenModel = undefined;
            const effort = this.flags.effortLevel;
            this.hooks.onChosen?.(typeof effort === "string" ? { model: undefined, effort } : {});
            return;
          }
          return this.requestModel(picked).then(
            () => {},
            (err: Error) => log.warn(`picked model not applied: ${err.message}`),
          );
        })
        .then(() => {
          if (!mode || mode === started || this.modePicks !== picks) return;
          return this.request("set_permission_mode", { mode }).then(
            () => {},
            (err: Error) => log.warn(`mode ${mode} not given again: ${err.message}`),
          );
        })
        .then(() => {
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

  private async rejectStartup(message: string): Promise<false> {
    if (this.disposed) return false;
    log.warn(`Claude startup failed: ${safeText(message, 200, redactLogSecrets)}`);
    try {
      await this.startup.reject();
    } catch (error) {
      log.warn(`Claude startup cleanup failed: ${(error as Error).message}`);
    }
    this.flushNow();
    this.update((prev) => ({ ...prev, phase: "failed", error: message }));
    return false;
  }

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

  private async followSettings(): Promise<void> {
    if (!this.supports("get_settings")) return;
    const effort = effortToApply(await this.request("get_settings", {}).catch(() => null));
    if (effort && this.supports("apply_flag_settings")) {
      await this.request("apply_flag_settings", { settings: { effortLevel: effort } });
    }
  }

  async restart(): Promise<void> {
    if (this.changingSession) throw new Error("Claude is changing the conversation");
    await (this.connectionRestart.whenIdle() ?? this.restartProgram());
  }

  profileConnectionChanged(profileId: string): void {
    if (this.profileId === profileId) this.connectionRestart.request(profileId);
  }

  private async restartProgram(connectionChanged = false): Promise<boolean> {
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await stopChatProgram(workspaceId, tabId);
    }
    this.flushNow();
    return this.start({ ...this.startArgs(), ...(connectionChanged ? { connectionChanged } : {}) });
  }

  currentSession(): string | undefined {
    return this.sessionId;
  }

  get sandboxSession(): string | null {
    this.flushNow();
    return this.disposed || this.changingSession ? null : this.sandboxSessionId;
  }

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

  unverifiedHistoryStart(): string | undefined {
    if (!this.earlierHistoryUnknown) return;
    const { history, model } = this.state;
    for (const items of [history?.items ?? [], model.items]) {
      for (const item of items) {
        if ((item.kind === "user" || item.kind === "assistant") && item.uuid) return item.uuid;
      }
    }
  }

  private rewindHistory(uuid: string): ChatModel {
    this.flushNow();
    const all = joinHistory(this.state.history, this.state.model);
    if (
      !all.items.some(
        (item) => item.kind === "user" && item.state === "taken" && item.uuid === uuid,
      )
    )
      throw new Error(i18next.t("chat.rewind.message_unavailable"));
    return all;
  }

  async previewRewind(uuid: string): Promise<RewindPreview> {
    this.rewindHistory(uuid);
    this.forkPoint(uuid, { before: true });
    if (!(await this.ensureRunning())) throw new Error("the program is not running");
    return rewindOf(await this.request("rewind_files", { user_message_id: uuid, dry_run: true }));
  }

  async rewind(
    item: UserItem,
    { files, draft = true }: { files: boolean; draft?: boolean },
  ): Promise<void> {
    const uuid = item.uuid;
    if (!uuid) throw new Error("the message has no uuid yet");
    const all = this.rewindHistory(uuid);
    const source = this.sessionId ?? this.target.fork?.sessionId;
    const clears = this.state.model.clears;
    const checkTarget = () => {
      if (
        (this.sessionId ?? this.target.fork?.sessionId) !== source ||
        this.state.model.clears !== clears
      )
        throw new Error(i18next.t("chat.rewind.message_unavailable"));
      if (this.state.model.running || this.writingUserMessage) throw new Error("a turn is running");
    };
    checkTarget();
    const fork = this.forkPoint(uuid, { before: true }) ?? undefined;
    const incomplete = this.earlierHistoryUnknown;
    if (files && !(await this.ensureRunning())) throw new Error("the program is not running");

    let restoredFiles = false;
    try {
      await this.changeSession(
        async () => {
          this.sessionId = undefined;
          this.target = { ...this.target, sessionId: undefined, fork };
          const kept = modelBefore(all, uuid);
          this.update((prev) => ({
            ...prev,
            history: kept.items.length > 0 ? kept : null,
            model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
          }));
          if (incomplete && fork)
            await this.loadTranscript(fork.sessionId, forkCut(fork), this.forkProfile());
          await this.startChangedSession(this.startArgs());
          await this.rebuild();
          if (this.disposed) throw new Error("the tab closed");
        },
        checkTarget,
        files
          ? async () => {
              const result = rewindOf(
                await this.request("rewind_files", { user_message_id: uuid }),
              );
              if (!result.canRewind) throw new Error(result.error ?? "the files were not rewound");
              restoredFiles = true;
            }
          : undefined,
      );
    } catch (error) {
      if (restoredFiles) {
        throw new Error(
          i18next.t("chat.rewind.files_restored_only", { error: (error as Error).message }),
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    const copy = this.target.fork;
    this.hooks.onTarget?.(
      copy ? { fork: copy } : this.sessionId ? { sessionId: this.sessionId } : {},
    );
    const name = this.pendingName ?? this.ownName;
    if (this.sessionId && name) void this.renameSession(name).catch(() => {});
    if (draft) {
      this.update((prev) => ({
        ...prev,
        draft: { text: item.text, images: item.images, nonce: Date.now() },
      }));
    }
  }

  async resumeSession(sessionId: string, profileId?: string, emptyOnly = false): Promise<void> {
    const checkTarget = () => {
      if (this.state.model.running) throw new Error("a turn is running");
      const same = profileId === undefined || sameProfile(profileId, this.target.profileId);
      if (emptyOnly) {
        if (!same)
          throw new Error("use a tab with the conversation's profile, or resume in a new tab");
        if (
          this.target.sessionId ||
          this.target.fork ||
          this.state.model.items.some(
            (item) => item.kind === "user" || item.kind === "assistant",
          ) ||
          this.state.queue.length > 0 ||
          this.transcriptPages
        )
          throw new Error("resume --tab requires an empty tab");
      } else if (this.state.queue.length > 0 && (this.sessionId !== sessionId || !same)) {
        throw new Error(i18next.t("chat.sessions.resume_queued"));
      }
    };
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
    }, checkTarget);
  }

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

  private async changeSession(
    change: (shown: number) => Promise<void>,
    checkTarget?: () => void,
    beforeStop?: () => Promise<void>,
  ): Promise<void> {
    if (
      this.disposed ||
      this.changingSession ||
      this.connectionRestart.active ||
      this.startup.pending ||
      this.state.queue.some((item) => item.status === "sending")
    ) {
      throw new Error("Claude is changing the conversation");
    }
    this.changingSession = true;
    try {
      this.flushNow();
      checkTarget?.();
      if (beforeStop) {
        await beforeStop();
        this.flushNow();
        if (this.disposed) throw new Error("the tab closed");
        checkTarget?.();
      }
      const shown = this.state.model.items.length;
      if (this.state.model.process === "running") {
        await stopChatProgram(this.target.workspaceId, this.target.tabId);
      }
      this.flushNow();
      if (this.disposed) throw new Error("the tab closed");
      checkTarget?.();
      this.sandboxSessionId = crypto.randomUUID();
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

  private async startChangedSession(args: StartArgs): Promise<void> {
    if (!(await this.start({ ...args, resetLog: true }))) {
      throw new Error(this.state.error ?? "Claude could not start the requested session");
    }
  }

  private publishSessionTarget(): void {
    const fork = this.target.fork;
    if (fork) this.hooks.onTarget?.({ fork });
    else if (this.sessionId) this.hooks.onTarget?.({ sessionId: this.sessionId });
  }

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
      const model = this.state.model;
      const items = model.items.filter(
        (item, i) => i < shown || !(item.kind === "notice" && item.code === "exited"),
      );
      const joined = joinHistory(this.state.history, { ...model, items });
      const all = { ...emptyModel(), items: joined.items, tools: joined.tools };
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
    if (name === this.sessionName) return true;
    if (!(await this.ensureRunning()) || !this.supports("rename_session")) return false;
    await this.request("rename_session", {
      title: name,
      source: "host",
      session_id: sessionId,
    });
    return true;
  }

  keepName(title: string | undefined): void {
    this.ownName = title?.trim() || undefined;
  }

  private retellName(): void {
    const sessionId = this.state.model.sessionId ?? this.sessionId;
    if (!this.ownName || !sessionId || !this.supports("rename_session")) return;
    void this.request("rename_session", {
      title: this.ownName,
      source: "host",
      session_id: sessionId,
    }).catch(() => {});
  }

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

  private replay(afterSeq?: number): Promise<ReplayResult> {
    return replayTab(
      {
        target: this.target,
        live: this.live,
        disposed: () => this.disposed,
        lastSeq: () => this.state.model.lastSeq,
        flushNow: () => this.flushNow(),
        keep: (lines) => this.buffered.push(...lines),
      },
      afterSeq,
    );
  }

  async resync(): Promise<void> {
    this.flushNow();
    const source = this.transcriptSource;
    let replay: ReplayResult;
    try {
      replay = await this.replay(this.state.model.lastSeq);
    } catch {
      this.resyncRetry.failed();
      return;
    }
    this.resyncRetry.settled();
    if (this.disposed || this.changingSession || this.transcriptSource !== source) return;
    if (replay.found) {
      if (!replay.running) this.holdUnread();
      this.update((prev) => ({ ...prev, phase: replay.running ? "ready" : "ended" }));
      this.sendNextQueued();
      return;
    }
    const pages = this.transcriptPages;
    if (!pages && this.opening) return;
    this.holdUnread();
    if (source && pages) {
      this.fullTranscript = undefined;
      this.transcriptSource = {
        ...source,
        appended: joinHistory(source.appended ?? null, this.state.model),
      };
      pages.expireCursor();
    } else {
      const earlierHistoryUnknown = this.earlierHistoryUnknown;
      this.resetTranscript(this.state.truncated);
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
    this.sendNextQueued();
  }

  held(): void {
    this.update(heldTab);
  }

  private holdUnread(): void {
    this.update((prev) => holdUnread(prev, (id) => this.hooks.relayedFrom?.(id)));
  }

  async prepareSend(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    this.flushNow();
  }

  send(text: string, images: ImageBlock[] = [], from?: RelaySender, id?: string): Promise<void> {
    return this.sendMessage(text, images, false, from, id);
  }

  sendNow(text: string, images: ImageBlock[] = [], from?: RelaySender, id?: string): Promise<void> {
    return this.sendMessage(text, images, true, from, id);
  }

  async submitLocal(text: string, images: ImageBlock[], now: boolean): Promise<void> {
    await this.sendMessage(text, images, now, undefined, undefined, false, true);
  }

  async readHeldNow(): Promise<void> {
    if (this.supports("background_tasks")) {
      const result = await this.request("background_tasks", {}).catch(() => undefined);
      if (result && result.backgrounded !== false) return;
    }
    await this.interrupt();
  }

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
    localSubmission = false,
  ): Promise<undefined> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    await this.initializing;
    const restart = this.connectionRestart.whenIdle();
    if (restart && !(await this.connectionRestart.wait(restart)))
      throw new Error(this.state.error ?? "Claude is not running");
    await this.refreshFreshInstructions();
    if (this.changingSession) throw new Error("Claude is changing the conversation");
    if (queued && !this.state.queue.some((entry) => entry.id === id && entry.status === "sending"))
      throw new Error("The conversation changed while delivering a queued message");
    const first = !this.titled && text.trim() ? text.trim() : undefined;
    if (first) {
      this.titled = true;
      this.hooks.onFirstMessage?.(first);
    }
    const message = userMessageOf(from ? relayedText(from, text) : text, images, now, id);
    if (from) this.hooks.onRelayed?.({ id: String(message.uuid), from, at: Date.now() });
    this.writingUserMessage += 1;
    try {
      await this.write(message);
      this.freshPromptSent = true;
      this.flushNow();
    } catch (error) {
      if (!localSubmission || isChatWriteRejected(error) || this.disposed) throw error;
      const uuid = String(message.uuid);
      this.flushNow();
      if (!this.sawQueuedMessage(uuid)) {
        const pending = unconfirmedMessage({ id: uuid, text, images }, error);
        this.update((prev) => ({ ...prev, queue: [...prev.queue, pending] }));
      }
      return;
    } finally {
      this.writingUserMessage -= 1;
    }
    if (id) this.hooks.onPeerWritten?.(id);
    if (first && !this.named && !this.ownName) void this.nameSession(first);
  }

  private async nameSession(text: string): Promise<void> {
    const result = await this.request("generate_session_title", {
      description: text.slice(0, TITLE_FROM_CHARS),
      persist: true,
    }).catch(() => undefined);
    const title = typeof result?.title === "string" ? result.title.trim() : "";
    if (title) this.hooks.onTitle?.(title);
  }

  clearDraft(): void {
    this.update((prev) => (prev.draft ? { ...prev, draft: undefined } : prev));
  }

  enqueue(
    text: string,
    images: ImageBlock[] = [],
    from?: RelaySender,
    device?: string,
    id?: string,
  ): string | undefined {
    if (this.changingSession) throw new Error("Claude is changing the conversation");
    const item: QueuedMessage = {
      id: id ?? nextRequestId(),
      text,
      images,
      ...(from ? { from } : {}),
      ...(device ? { device } : {}),
    };
    this.update((prev) => ({ ...prev, queue: [...prev.queue, item] }));
    this.sendNextQueued();
    return this.state.queue.some((entry) => entry.id === item.id) ? item.id : undefined;
  }

  removeQueued(id: string): QueuedMessage | undefined {
    return removeQueuedIn(this.state, (change) => this.update(change), id);
  }

  editQueued(id: string, text: string, device?: string, from?: RelaySender): boolean {
    return editQueuedIn(this.state, (change) => this.update(change), id, text, device, from);
  }

  private sendNextQueued(): void {
    if (this.changingSession || this.connectionRestart.whenIdle()) return;
    dispatchQueuedMessage(
      this.state.queue,
      (update) => this.update(update),
      (next) => this.sendMessage(next.text, next.images, false, next.from, next.id, true),
      isChatWriteRejected,
      (id) => this.sawQueuedMessage(id),
      () => {
        this.flushNow();
        this.sendNextQueued();
      },
      (item) => this.canSendQueued(item),
    );
  }

  private canSendQueued(item: QueuedMessage): boolean {
    return (
      !this.disposed &&
      this.state.phase !== "held" &&
      (!this.state.model.running || item.afterTool !== undefined)
    );
  }

  private sawQueuedMessage(id: string): boolean {
    return this.state.model.items.some((item) => item.kind === "user" && item.sentUuid === id);
  }

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

  private requestModel(model: string): Promise<Record<string, unknown>> {
    const selected = model === "default" ? (this.claudeProfileDefaultModel ?? model) : model;
    return this.request("set_model", { model: selected });
  }

  setModel(model: string): Promise<unknown> {
    return this.shownAtOnce("model", model, () => this.requestModel(model)).then((answer) => {
      this.chosenModel = model;
      this.hooks.onChosen?.({ model });
      return answer;
    });
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

  stopTask(taskId: string): Promise<unknown> {
    return this.request("stop_task", { task_id: taskId });
  }

  refreshPanel(parts: readonly PanelPart[]): void {
    if (!this.lineCanAsk()) return;
    for (const part of parts) {
      if (part === "context") {
        this.refreshContext();
        continue;
      }
      if (part === "usage") {
        void this.initializing
          .catch(() => {})
          .then(() => wantPlanUsage(this.usageKey(), { force: true }));
        continue;
      }
      const subtype = PANEL_REQUESTS[part];
      if (!this.supports(subtype)) continue;
      void this.initializing.catch(() => {}).then(() => this.askPanel(part, subtype));
    }
  }

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

  private panelParams(part: PanelPart): Record<string, unknown> {
    const version = this.state.version ?? this.state.model.version;
    return part === "usage" && usageSkipsBehaviors(version) ? { skip_behaviors: true } : {};
  }

  private refreshContext(retry = true): void {
    if (!this.lineCanAsk() || !this.supports(PANEL_REQUESTS.context)) return;
    this.contextAsks += 1;
    this.request(PANEL_REQUESTS.context, {}).then(
      () => {
        this.contextAsks -= 1;
      },
      () => {
        this.contextAsks -= 1;
        if (retry) setTimeout(() => this.refreshContext(false), CONTEXT_RETRY_MS);
      },
    );
  }

  private askContextBase(): void {
    if (this.contextBaseAsked || this.contextAsks > 0) return;
    if (this.state.model.contextUsage !== undefined) return;
    if (!this.lineCanAsk() || !this.supports(PANEL_REQUESTS.context)) return;
    this.contextBaseAsked = true;
    this.refreshContext();
  }

  async mcpReconnect(serverName: string): Promise<void> {
    try {
      await this.request("mcp_reconnect", { serverName });
    } finally {
      this.refreshPanel(["mcp"]);
    }
  }

  async mcpAuthenticate(serverName: string): Promise<void> {
    if (this.state.mcpSignIn) this.cancelMcpSignIn();
    const { id, redirectUri } = unwrapIpcResult(await ipcCallResult("chat", "oauthListen", {}));
    try {
      const page = signInPageOf(
        await this.request("mcp_authenticate", { serverName, redirectUri }),
      );
      const authUrl = page.authUrl;
      if (!authUrl) {
        void ipcCallResult("chat", "oauthCancel", { id });
        await this.request("mcp_reconnect", { serverName });
        return;
      }
      if (!page.back) {
        void ipcCallResult("chat", "oauthCancel", { id });
        openSignInPage(authUrl);
        return;
      }
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

  async mcpSignedIn(serverName: string, callbackUrl: string): Promise<void> {
    try {
      await this.request("mcp_oauth_callback_url", { serverName, callbackUrl });
      await this.request("mcp_reconnect", { serverName });
    } finally {
      this.refreshPanel(["mcp"]);
    }
  }

  reopenMcpSignIn(): void {
    const signIn = this.state.mcpSignIn;
    if (signIn) openSignInPage(signIn.authUrl);
  }

  cancelMcpSignIn(): void {
    const signIn = this.state.mcpSignIn;
    if (!signIn) return;
    void ipcCallResult("chat", "oauthCancel", { id: signIn.callbackId });
    this.update((prev) => ({ ...prev, mcpSignIn: undefined }));
  }

  async askAside(question: string): Promise<string | null> {
    await this.settled();
    const body = await this.request("side_question", { question }, SIDE_QUESTION_TIMEOUT_MS);
    return typeof body.response === "string" ? body.response : null;
  }

  async applyFlags(settings: Record<string, unknown>): Promise<void> {
    await this.settled();
    await this.request("apply_flag_settings", { settings });
    this.flags = { ...this.flags, ...settings };
  }

  addedDirectories(): string[] {
    const permissions = this.flags.permissions as { additionalDirectories?: string[] } | undefined;
    return permissions?.additionalDirectories ?? [];
  }

  async backgroundTool(toolUseId: string): Promise<void> {
    await this.request("background_tasks", { tool_use_id: toolUseId });
  }

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

  async reloadPlugins(): Promise<void> {
    if (this.state.model.process !== "running" || !this.supports("reload_plugins")) return;
    await this.request("reload_plugins", {});
  }

  private async settled(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Claude is not running");
    await this.initializing;
  }

  async cliSandbox() {
    if (this.state.phase !== "ready" || this.state.model.process !== "running") return null;
    const settings = await this.request("get_settings", {});
    return { agent: "claude" as const, enabled: sandboxOn(settings) };
  }

  async ask(subtype: string): Promise<Record<string, unknown>> {
    await this.settled();
    return this.request(subtype, {});
  }

  async readConfig(): Promise<{
    effective: Record<string, unknown>;
    global: Record<string, unknown>;
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

  private configKeysPlace(): { place: string; version: string } {
    const { workspaceId, profileId } = this.target;
    return {
      place: [workspaceId, profileId ?? ""].join("\n"),
      version: this.state.version ?? this.state.model.version ?? "",
    };
  }

  savedConfigKeys(): ListedKey[] | null {
    const { place, version } = this.configKeysPlace();
    try {
      return savedListedKeys(localStorage.getItem(LISTED_KEYS_STORAGE), place, version);
    } catch {
      return null;
    }
  }

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

  async sendCommands(texts: readonly string[], waitForLast = false): Promise<void> {
    for (const [index, text] of texts.entries()) {
      if (!(await this.ensureRunning())) throw new Error("Claude is not running");
      await this.initializing;
      await this.refreshFreshInstructions();
      const message = userMessageOf(text, []);
      await this.write(message);
      if (waitForLast || index < texts.length - 1) {
        await this.commandDone(message.uuid as string);
      }
    }
  }

  private async commandDone(uuid: string): Promise<void> {
    const deadline = Date.now() + COMMAND_DONE_MS;
    while (!this.disposed && Date.now() < deadline) {
      this.flushNow();
      const { running, items } = this.state.model;
      if (!running && items.some((item) => item.kind === "user" && item.sentUuid === uuid)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

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

  showCard(card: Omit<CommandCard, "id">): string {
    const id = nextRequestId();
    this.update((prev) => ({ ...prev, card: { ...card, id } }));
    return id;
  }

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

  attach(name: string, data: string): Promise<string> {
    return attachToTab(this.target, name, data);
  }

  setRemoteControl(enabled?: boolean): Promise<{ enabled: boolean; url?: string }> {
    const deadline = performance.now() + 45_000;
    const change = this.remoteControlChange.then(async () => {
      const left = deadline - performance.now();
      if (left <= 0) throw new Error("Remote Control was not changed in time");
      this.flushNow();
      const next = enabled ?? this.state.model.remoteControl?.enabled !== true;
      const answer = await this.request(
        "remote_control",
        { enabled: next },
        Math.min(CONTROL_TIMEOUT_MS, left),
      );
      const url = next && typeof answer.session_url === "string" ? answer.session_url : undefined;
      this.update((state) => ({
        ...state,
        model: { ...state.model, remoteControl: { enabled: next, sessionUrl: url } },
      }));
      if (next) this.retellName();
      return { enabled: next, ...(url ? { url } : {}) };
    });
    this.remoteControlChange = change.catch(() => {});
    return change;
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
    const open = this.state.model.permissions.some((p) => p.requestId !== request.requestId);
    if (!open) {
      const { workspaceId, tabId } = this.target;
      const stopped = answer.kind === "deny-stop";
      ipcCallResult("claude", "answeredInChat", { workspaceId, tabId, stopped }).catch(
        (err: Error) => log.warn(`answer not told: ${err.message}`),
      );
    }
  }

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
    const instructions =
      message.type === "user" ? this.hooks.instructions?.(this.sessionId) : undefined;
    unwrapIpcResult(
      await ipcCallResult("chat", "send", {
        workspaceId,
        tabId,
        message,
        ...(instructions === undefined
          ? {}
          : { instructions, ...profileArg(this.target.profileId) }),
      }),
    );
  }

  private async refreshFreshInstructions(): Promise<void> {
    const { running, items } = this.state.model;
    if (
      this.launchInstructions === undefined ||
      this.freshPromptSent ||
      running ||
      items.some((item) => item.kind === "assistant")
    )
      return;
    const session = this.hooks.instructions?.(this.sessionId) ?? "";
    const latest = this.hooks.mergedInstructions?.(this.target.profileId, session);
    if (latest === this.launchInstructions) return;
    await this.changeSession(async () => {
      await this.startChangedSession(this.startArgs());
      await this.initializing;
    });
  }

  private async ensureRunning(): Promise<boolean> {
    if (this.disposed || this.changingSession) return false;
    if (this.opening) {
      await this.opening;
      if (this.state.phase === "failed") return false;
    }
    this.flushNow();
    const restart = this.connectionRestart.whenIdle();
    if (restart) return this.connectionRestart.wait(restart);
    if (this.startup.pending) return this.startup.pending;
    const { phase, model } = this.state;
    if (phase === "ready" && model.process === "running") return true;
    if (phase === "held" || phase === "not-found") return false;
    return this.start(this.startArgs());
  }

  receive(line: ChatLine): void {
    if (this.disposed) return;
    if (!line.replay) this.inspectLive(line);
    if (this.live.holds(line)) return;
    this.buffered.push(line);
    if (this.hooks.onTurnEnd && liveClaudeResult(line)) this.flushNow();
    else if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flushNow(), 16);
  }

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
      this.refreshContext();
      if (message.type === "result") {
        this.contextBaseAsked = false;
        void wantPlanUsage(this.usageKey());
      }
      if (message.type === "result" && this.state.model.goal?.status === "active") {
        for (const ms of GOAL_SYNC_MS) setTimeout(() => void this.syncGoal(), ms);
      }
    } else if (message.type === "system" && message.subtype === "session_title_changed") {
      const title = typeof message.title === "string" ? message.title.trim() : "";
      if (title && title !== this.sessionName) {
        this.sessionName = title;
        this.titled = true;
        if (!this.changingSession) this.hooks.onRename?.(title);
      }
    } else if (message.type === "control_request") {
      const request = message.request as Record<string, unknown> | undefined;
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
    if (!this.changingSession && model.process === "exited" && lines.some(liveExit))
      this.holdUnread();
    this.afterModel(before, model);
    if (lines.some(liveMainCall)) this.askContextBase();
    if (model.lastResult !== before.lastResult && lines.some(liveClaudeResult))
      this.hooks.onTurnEnd?.(model);
  }

  private afterModel(before: ChatModel, model: ChatModel): void {
    if (before.init !== model.init) {
      const catalog = useClaudeModelCatalog.getState();
      if (model.init?.models.length) {
        catalog.remember({
          tabKey: this.key,
          profileKey: this.modelCatalogKey,
          models: model.init.models,
        });
      } else {
        catalog.forget(this.key);
      }
    }
    if (before.goal !== model.goal) this.liveGoalChanged = true;
    if (model.permissionMode) this.lastMode = model.permissionMode;
    if (model.sessionId && model.sessionId !== this.sessionId) {
      const name = this.pendingName ?? this.target.fork?.title ?? this.ownName;
      if (this.sessionId && !this.changingSession) this.sandboxSessionId = crypto.randomUUID();
      this.sessionId = model.sessionId;
      this.target = { ...this.target, fork: undefined };
      if (!this.changingSession) {
        this.hooks.onSession?.(model.sessionId);
        if (name) void this.renameSession(name).catch(() => {});
      }
    }
    if ((model.clears ?? 0) !== (before.clears ?? 0)) {
      this.sandboxSessionId = crypto.randomUUID();
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
      this.contextBaseAsked = false;
    }
  }

  private rejectPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

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
    this.connectionRestart.dispose();
    this.resyncRetry.stop();
    this.removeReceiver?.();
    this.leavePlanUsage();
    useClaudeModelCatalog.getState().forget(this.key);
    useChatStore.getState().remove(this.key);
    controllers.delete(this.key);
  }
}

function savedProfileConnection(profileId: string | undefined): ProfileConnection | undefined {
  return profileOf(useAgentProfilesStore.getState().config, "claude", profileId).connection;
}

function liveClaudeResult(line: ChatLine): boolean {
  return (
    !line.replay &&
    line.dir === "out" &&
    (line.message as { type?: string } | undefined)?.type === "result"
  );
}

function liveExit(line: ChatLine): boolean {
  return (
    !line.replay &&
    line.dir === "sys" &&
    (line.message as { event?: string } | undefined)?.event === "exit"
  );
}

function liveMainCall(line: ChatLine): boolean {
  return !line.replay && line.dir === "out" && mainCallContextTokens(line.message) !== undefined;
}

function phaseAfter(phase: ChatTabState["phase"], model: ChatModel): ChatTabState["phase"] {
  if (model.process === "exited" && (phase === "ready" || phase === "held")) return "ended";
  if (model.process === "running" && (phase === "ended" || phase === "held")) return "ready";
  return phase;
}

export function profileArg(profileId: string | undefined): { profileId?: string } {
  return profileId ? { profileId } : {};
}

function startChat(
  args: StartArgs & {
    workspaceId: string;
    tabId: string;
    cwd: string;
    profileId?: string;
    instructions?: string;
    usageOnly?: boolean;
  },
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

const controllers = new Map<string, ChatController>();

registerWorkspaceCleanup((workspaceId) => {
  const prefix = `${workspaceId}:`;
  for (const [key, controller] of controllers) {
    if (key.startsWith(prefix)) controller.dispose();
  }
});
function openSignInPage(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

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

export function refreshClaudeProfileConnection(profileId: string): void {
  for (const controller of controllers.values()) controller.profileConnectionChanged(profileId);
}

export function closeChatTab(workspaceId: string, tabId: string): void {
  const controller = controllers.get(chatKey(workspaceId, tabId));
  if (controller) {
    void controller.close();
    return;
  }
  void ipcCallResult("chat", "close", { workspaceId, tabId }).catch(() => {});
}

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
