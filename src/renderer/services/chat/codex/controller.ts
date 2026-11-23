import {
  connectionReasoningLevels,
  type ProfileConnection,
} from "../../../../shared/agent-profiles/connection";
import {
  defaultProfileId,
  isDefaultProfileId,
  profileOf,
} from "../../../../shared/agent-profiles/profiles";
import { type RelayedMessage, type RelaySender, relayedText } from "../../../../shared/chat/relay";
import { createLogger } from "../../../../shared/log/renderer";
import { CHAT_MODES } from "../../../../shared/sessions/chat-modes";
import type { ChatChosen, CodexFork, ProfileMove } from "../../../../shared/types/layout";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { registerWorkspaceCleanup } from "../../../state/workspace-cleanup";
import { readOpenHistories, removeConversationAttachments } from "../attach-retention";
import type { PermissionAnswer, RewindPreview } from "../claude/controller";
import type {
  AssistantItem,
  ChatItem,
  ChatLine,
  ImageBlock,
  PermissionRequest,
  UserItem,
} from "../model";
import {
  forgetPlanWait,
  ingestCodexPush,
  planUsageKeyFor,
  registerPlanSource,
  wantPlanUsage,
} from "../plan-usage";
import { lastMessageId, sameProfile, withMove } from "../profile-moves";
import type { ListedSession } from "../sessions";
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
  type ReplayResult,
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
} from "../transport/queue";
import { addLineReceiver } from "../transport/receivers";
import { compareVersions } from "../versions";
import { type CodexCollaborationMode, collaborationPresetsOf } from "./collaboration";
import { type CodexMcpServer, mcpServersOf } from "./commands";
import {
  CODEX_CONFIG_PROFILE_KEY,
  CodexConfigRefusal,
  type CodexConfigSet,
  codexConfigEdits,
  codexConfigSnapshot,
} from "./config";
import {
  appendCodexForkPage,
  codexForkPrefix,
  codexForkSourceStatus,
  codexHistoryAvailable,
  codexHistoryBusy,
  codexServerVersion,
  emptyCodexForkPages,
  readCodexThread,
  validCodexFork,
} from "./history";
import { invalidateCodexHistory } from "./history-catalog";
import {
  applyCodexLines,
  type CodexMode,
  type CodexModel,
  codexModelsOf,
  codexThreadItems,
  emptyCodexModel,
  idKey,
  isThreadStatusChanged,
  loseCodexLog,
  modeOf,
  nextThreadModel,
  shownUserText,
} from "./model";
import {
  type ContinuedCodexChoices,
  matchesProfileForkSettings,
  profileForkSettings,
} from "./profile-fork";

const log = createLogger("codex");

export const MIN_CODEX_VERSION = "0.166.0";

const REQUEST_TIMEOUT_MS = 30_000;

const HISTORY_MUTATIONS = new Set([
  "thread/fork",
  "thread/delete",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "turn/start",
  "turn/steer",
]);
const MAX_SUGGESTIONS = 50;

const SUPPORTED = new Set(["apply_flag_settings", "file_suggestions"]);

const MODE_SETTINGS: Record<CodexMode, { approvalPolicy: string; sandboxPolicy: object }> = {
  readOnly: {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  },
  auto: {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  },
  fullAccess: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
};

const UNSUPPORTED = { code: -32601, message: "NexusCode does not answer this request" };

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexTabTarget {
  workspaceId: string;
  tabId: string;
  cwd: string;
  threadId?: string;
  fork?: CodexFork;
  profileId?: string;
  moves?: readonly ProfileMove[];
  chosen?: ChatChosen;
}

export interface CodexTabHooks {
  instructions?: (threadId?: string) => string;
  onThread?: (threadId: string) => void;
  onFirstMessage?: (text: string) => void;
  onTitle?: (title: string) => void;
  onProfile?: (profileId: string) => void;
  onMoves?: (moves: readonly ProfileMove[]) => void;
  onRelayed?: (record: RelayedMessage) => void;
  onChosen?: (chosen: ChatChosen) => void;
  onTurnEnd?: (model: CodexModel) => void;
}

function turnIdOf(result: Record<string, unknown>): string | undefined {
  const turn = result.turn;
  const id =
    turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : result.turnId;
  return typeof id === "string" ? id : undefined;
}

function requireThreadId(result: Record<string, unknown>, expected?: string): string {
  const id = (result.thread as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id || (expected !== undefined && id !== expected)) {
    throw new Error("Codex did not return the requested thread");
  }
  return id;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `app-${Date.now().toString(36)}-${counter}`;
}

export class CodexReplyError extends Error {}

export class CodexController {
  readonly key: string;
  readonly modes = CHAT_MODES.codex;
  private target: CodexTabTarget;
  private hooks: CodexTabHooks;
  private readonly pending = new Map<string, Pending>();
  private buffered: ChatLine[] = [];
  private readonly live = new LiveLines();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private opening: Promise<void> | null = null;
  private readonly startup = new ProgramStartup(() =>
    stopChatProgram(this.target.workspaceId, this.target.tabId),
  );
  private readonly connectionRestart = new ConnectionRestart(
    (profileId) => {
      if (this.disposed || this.profileId !== profileId) return "skip";
      const { phase, queue } = this.state;
      const model = this.model;
      if (
        this.opening ||
        this.startup.pending ||
        this.rewinding ||
        this.resumingSelection ||
        this.startingTurn ||
        this.collaborationChange ||
        this.buffered.length ||
        phase === "held" ||
        model.running ||
        Object.values(model.tasks).some((task) => task.status === "running") ||
        queue.some((item) => item.status === "sending")
      )
        return "wait";
      return model.process === "running" ||
        ((phase === "ended" || phase === "failed") && this.currentThread())
        ? "ready"
        : "skip";
    },
    () => this.restartProgram(true),
    () => this.sendNextQueued(),
    (error) => log.warn(`Codex could not restart after a profile edit: ${String(error)}`),
  );
  private ready: Promise<boolean> = Promise.resolve(false);
  private handshaking: Promise<boolean> | null = null;
  private introduced: Promise<boolean> = Promise.resolve(true);
  private disposed = false;
  private titled = false;
  private rewinding = false;
  private startingTurn?: Promise<void>;
  private stoppingTurn?: string;
  private deferToolSendsForTurn?: string;
  private resumingSelection = false;
  private sandboxSessionId = crypto.randomUUID();
  private emptyThread?: string;
  private canonicalCwd: string | undefined;
  private connection: ProfileConnection | undefined;
  private agentRefresh: ReturnType<typeof setTimeout> | undefined;
  private readonly readingAgents = new Map<string, Promise<void>>();
  private readonly readAgentAt = new Map<string, number>();
  private readonly readAgentVersion = new Map<string, number>();
  private readonly dirtyAgents = new Set<string>();
  private discoverAgents = false;
  private refreshingAgents = false;
  private mcpRead: object | undefined;
  private next: CodexPicks = {};
  private turnPicks?: { threadId: string; clientId: string; picks: CodexPicks };
  private readonly removeReceiver: () => void;
  private readonly leavePlanUsage: () => void;
  private limitsReadable = false;
  private collaborationProbe?: Promise<ReturnType<typeof collaborationPresetsOf>>;
  private collaborationChange?: Promise<void>;
  private pickedPermissionMode?: CodexMode;

  constructor(target: CodexTabTarget, hooks: CodexTabHooks = {}) {
    this.target = target;
    this.hooks = hooks;
    this.connection = savedProfileConnection(target.profileId);
    this.key = chatKey(target.workspaceId, target.tabId);
    this.next = picksFrom(target.chosen);
    this.removeReceiver = addLineReceiver(this);
    this.leavePlanUsage = registerPlanSource({
      agent: "codex",
      usageKey: () => this.usageKey(),
      ready: () =>
        this.limitsReadable && this.state.phase === "ready" && this.model.process === "running",
      busy: () => this.model.running,
      fetchUsage: () => this.readPlanUsage(),
    });
  }

  usageKey(): string {
    return planUsageKeyFor("codex", this.target.workspaceId, this.target.profileId);
  }

  get state(): ChatTabState {
    return useChatStore.getState().tabs[this.key] ?? emptyTabState();
  }

  get model(): CodexModel {
    const model = this.state.model as Partial<CodexModel>;
    return model.requests ? (model as CodexModel) : { ...emptyCodexModel(), ...model };
  }

  setHooks(hooks: CodexTabHooks): void {
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
    this.opening = this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    if (this.startup.failed) {
      await this.start({});
      return;
    }
    this.flushNow();
    this.update((prev) => ({
      ...prev,
      phase: "starting",
      error: undefined,
      model: emptyCodexModel(),
    }));
    let replay: ReplayResult;
    try {
      replay = await this.replay();
    } catch (err) {
      this.update((prev) => ({ ...prev, phase: "failed", error: (err as Error).message }));
      return;
    }
    if (replay.found) {
      this.titled = this.titled || this.model.items.some((item) => item.kind === "user");
      this.update((prev) => ({
        ...prev,
        phase: replay.running ? "ready" : "ended",
        truncated: replay.truncated,
      }));
      this.showPicks();
      if (replay.running) {
        this.ready = Promise.resolve(this.model.threadId !== undefined);
        this.readRateLimits();
        if (!this.model.collaborationPresets) void this.availableCollaborationModes();
        this.scheduleSubagents();
      }
      return;
    }
    await this.start({});
  }

  private start(
    options: { resetLog?: boolean; connectionChanged?: boolean },
    catalogOnly = false,
    forkSettings?: ReturnType<typeof profileForkSettings>,
  ): Promise<boolean> {
    return this.startup.run(() => this.startProgram(options, catalogOnly, forkSettings));
  }

  private async startProgram(
    options: { resetLog?: boolean; connectionChanged?: boolean },
    catalogOnly = false,
    forkSettings?: ReturnType<typeof profileForkSettings>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const { workspaceId, tabId, cwd, profileId } = this.target;
    const connection = savedProfileConnection(profileId);
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined }));
    let result: Awaited<ReturnType<typeof startCodex>>;
    try {
      await this.startup.prepare();
      if (this.disposed) return false;
      result = await startCodex({
        workspaceId,
        tabId,
        cwd,
        ...options,
        ...(profileId ? { profileId } : {}),
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
    if (!isSupportedCodex(result.version)) {
      this.update((prev) => ({ ...prev, version: result.version }));
      return this.rejectStartup("old-version");
    }
    this.canonicalCwd = result.canonicalCwd;
    this.update((prev) => ({ ...prev, version: result.version }));
    if (result.attached) {
      if (options.resetLog || options.connectionChanged)
        return this.rejectStartup("Codex attached to the previous program");
      this.ready = this.handshaking ?? Promise.resolve(this.model.threadId !== undefined);
      this.startup.failed = false;
      this.update((prev) => ({ ...prev, phase: "ready" }));
      this.readRateLimits();
      void this.availableCollaborationModes();
      this.showPicks();
      return true;
    }
    if (options.connectionChanged) {
      const replacedCustomConnection =
        this.connection?.method === "custom" && connection?.method !== "custom";
      const picked = this.next.model;
      const validPick =
        connection?.method === "custom" && connection.models.some(({ id }) => id === picked);
      if (replacedCustomConnection || (picked && connection?.method === "custom" && !validPick)) {
        this.next = { mode: this.next.mode };
        this.hooks.onChosen?.({ model: undefined, effort: undefined });
      }
    }
    this.connection = connection;
    this.collaborationProbe = undefined;
    const introduced = this.introduce();
    this.introduced = introduced.then(
      () => true,
      () => false,
    );
    const handshake = (
      catalogOnly ? introduced : this.handshake(introduced, forkSettings, options.connectionChanged)
    )
      .then(
        async (threadId) => {
          if (this.disposed) return false;
          this.flushNow();
          if (this.model.process === "exited")
            return this.rejectStartup("Codex exited during startup");
          if (typeof threadId === "string" && this.model.threadId !== threadId) {
            this.patchModel({ threadId });
            this.rememberThread(threadId);
          }
          this.startup.failed = false;
          this.update((prev) => ({
            ...prev,
            phase: "ready",
            truncated: !options.resetLog && prev.truncated,
          }));
          if (!catalogOnly) this.showPicks();
          return true;
        },
        (error: Error) => this.rejectStartup(error.message),
      )
      .finally(() => {
        if (this.handshaking === handshake) this.handshaking = null;
      });
    this.handshaking = handshake;
    this.ready = handshake;
    return handshake;
  }

  private async rejectStartup(message: string): Promise<false> {
    if (this.disposed) return false;
    log.warn(`Codex startup failed: ${message}`);
    this.limitsReadable = false;
    try {
      await this.startup.reject();
    } catch (error) {
      log.warn(`Codex startup cleanup failed: ${(error as Error).message}`);
    }
    this.flushNow();
    this.update((prev) => ({ ...prev, phase: "failed", error: message }));
    return false;
  }

  private async introduce(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "nexus-code", title: "NexusCode", version: __APP_VERSION__ },
      capabilities: { experimentalApi: true },
    });
    await this.write({ method: "initialized" });
  }

  private async handshake(
    introduced: Promise<void>,
    forkSettings?: ReturnType<typeof profileForkSettings>,
    connectionChanged?: boolean,
  ): Promise<string> {
    await introduced;
    void this.request("account/read", {}).catch(() => {});
    void this.request("model/list", {}).catch(() => {});
    void this.probeCollaborationModes();
    this.readRateLimits();
    const { cwd } = this.target;
    const threadId = this.model.threadId ?? this.target.threadId;
    const fork = this.target.fork;
    if (!threadId && fork) {
      try {
        const crossProfile = fork.profileId && !sameProfile(fork.profileId, this.target.profileId);
        const settings = crossProfile
          ? (forkSettings ?? (await this.resolveForkSettings({})))
          : undefined;
        const staged = await this.stage(fork);
        const forked = await this.forkThread(fork, settings);
        const copy = requireThreadId(forked);
        this.readGoal(copy);
        this.titled = true;
        if (fork.title) {
          if (!this.resumingSelection) this.hooks.onTitle?.(fork.title);
          if (staged && copy) {
            void this.request("thread/name/set", { threadId: copy, name: fork.title }).catch(
              () => {},
            );
          }
        }
        return copy;
      } catch (err) {
        const message = (err as Error).message;
        log.warn(`thread ${fork.threadId} not forked: ${message}`);
        throw err;
      }
    }
    if (threadId) {
      let resumed: Record<string, unknown> | undefined;
      try {
        const settings = connectionChanged ? await this.changedThreadSettings(threadId) : undefined;
        if (settings?.providerChanged) {
          const name = this.model.threadName;
          const choices = {
            model: this.next.model,
            effort: this.next.effort,
            readOnly: this.pickedPermissionMode === "readOnly",
          };
          const defaults = await this.resolveForkSettings(choices);
          const forked = await this.forkThread({ threadId }, defaults, {
            modelProvider: settings.modelProvider,
            excludeTurns: this.model.items.some((item) => item.kind !== "notice"),
          });
          const id = requireThreadId(forked);
          if (name) void this.request("thread/name/set", { threadId: id, name }).catch(() => {});
          this.readGoal(id);
          return id;
        }
        resumed = await this.request("thread/resume", {
          threadId,
          cwd,
          excludeTurns: this.model.items.some((item) => item.kind !== "notice"),
          ...(settings?.model ? { model: settings.model } : {}),
        });
      } catch (err) {
        if (!this.canReplaceEmptyThread(threadId, err)) throw err;
        log.info(`starting again after Codex discarded empty thread ${threadId}`);
      }
      if (resumed) {
        requireThreadId(resumed, threadId);
        this.emptyThread = undefined;
        this.readGoal(threadId);
        return threadId;
      }
    }
    this.emptyThread = requireThreadId(
      await this.request("thread/start", threadStartParams(this.target, this.next)),
    );
    return this.emptyThread;
  }

  private async changedThreadSettings(threadId: string) {
    const { config } = await this.request("config/read", { cwd: this.target.cwd });
    const newConfig = config as { model_provider?: string; model?: string } | undefined;
    const modelProvider = newConfig?.model_provider ?? "openai";
    const model =
      this.next.model ??
      newConfig?.model ??
      codexModelsOf((await this.request("model/list", {})).data).find((option) => option.isDefault)
        ?.value;
    if (this.emptyThread === threadId) return { model, modelProvider, providerChanged: false };
    const source = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = source.thread as { id?: string; modelProvider?: string } | undefined;
    if (thread?.id !== threadId || !thread.modelProvider) {
      throw new Error("Codex did not report the saved thread's model provider");
    }
    return { model, modelProvider, providerChanged: thread.modelProvider !== modelProvider };
  }

  private canReplaceEmptyThread(threadId: string, error: unknown): boolean {
    return (
      !this.resumingSelection &&
      this.emptyThread === threadId &&
      !this.model.items.some((item) => item.kind !== "notice") &&
      error instanceof CodexReplyError &&
      error.message === `no rollout found for thread id ${threadId}`
    );
  }

  private async forkThread(
    fork: CodexFork,
    settings?: ReturnType<typeof profileForkSettings>,
    connection?: { modelProvider: string; excludeTurns: boolean },
  ): Promise<Record<string, unknown>> {
    const { threadId, beforeTurnId, lastTurnId } = fork;
    if (
      (beforeTurnId || lastTurnId) &&
      !codexHistoryAvailable(codexServerVersion(this.model, this.state.version))
    ) {
      throw new Error("This Codex version cannot fork at a turn boundary");
    }
    let expected: string[] | undefined;
    if (beforeTurnId || lastTurnId) {
      expected = await this.readForkPrefix(fork);
      this.flushNow();
      if (threadId === this.model.threadId && codexHistoryBusy(this.state)) {
        throw new Error("The source Codex thread is busy");
      }
    }
    const params = {
      threadId,
      cwd: this.target.cwd,
      ...settings,
      ...connection,
      ...(beforeTurnId ? { beforeTurnId, deferGoalContinuation: true } : {}),
      ...(lastTurnId ? { lastTurnId, deferGoalContinuation: true } : {}),
    };
    const result = await this.request("thread/fork", params);
    const permissionsMatch = matchesProfileForkSettings(params, result);
    const providerMatches = !connection || result.modelProvider === connection.modelProvider;
    if (!permissionsMatch || !providerMatches || !validCodexFork(fork, result, expected)) {
      const copy = result.thread as { id?: unknown; forkedFromId?: unknown } | undefined;
      if (typeof copy?.id === "string" && copy.id !== threadId && copy.forkedFromId === threadId) {
        await this.request("thread/delete", { threadId: copy.id }).catch(() => {});
      }
      throw new Error(
        !permissionsMatch
          ? "Codex did not apply the destination profile's permissions"
          : !providerMatches
            ? "Codex did not apply the destination profile's model provider"
            : "Codex returned an unexpected fork history",
      );
    }
    return result;
  }

  private async readForkPrefix(fork: CodexFork): Promise<string[]> {
    const { threadId } = fork;
    const source = await this.request("thread/read", { threadId, includeTurns: false });
    const status = codexForkSourceStatus(threadId, source);
    if (status === "active") throw new Error("The source Codex thread is busy");
    if (!status) throw new Error("Codex could not verify the source thread");

    let pages = emptyCodexForkPages();
    while (pages.nextCursor !== null) {
      const cursor = pages.nextCursor;
      const result = await this.request("thread/turns/list", {
        threadId,
        sortDirection: "asc",
        itemsView: "notLoaded",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const page = appendCodexForkPage(pages, cursor, result);
      if (!page) break;
      const expected = codexForkPrefix(fork, page.turns);
      if (expected) return expected;
      pages = page;
    }
    throw new Error("Codex could not verify the source turn");
  }

  private requireHistoryIdle(): void {
    this.flushNow();
    if (
      this.rewinding ||
      this.resumingSelection ||
      this.startingTurn ||
      codexHistoryBusy(this.state)
    ) {
      throw new Error("Wait for the current turn, approvals and queued messages to finish");
    }
  }

  get profileId(): string {
    return this.target.profileId ?? defaultProfileId("codex");
  }

  forkPoint(item?: UserItem | AssistantItem): CodexFork {
    this.requireHistoryIdle();
    const threadId = this.currentThread();
    if (!threadId || this.model.items.length === 0) throw new Error("Codex has no history to fork");
    if (!item) return { threadId };
    if (!codexHistoryAvailable(codexServerVersion(this.model, this.state.version))) {
      throw new Error("This Codex version cannot fork at a turn boundary");
    }
    const current = this.model.items.find((each) => each.key === item.key);
    if (current?.kind === "user" && current.forkable && current.turnId) {
      return { threadId, beforeTurnId: current.turnId };
    }
    if (current?.kind === "assistant" && current.forkable) {
      return { threadId, lastTurnId: current.messageId };
    }
    throw new Error("This message is not at a Codex turn boundary");
  }

  async previewRewind(itemKey: string): Promise<RewindPreview> {
    const item = this.model.items.find((each) => each.key === itemKey);
    if (item?.kind !== "user" || !item.rewindable) {
      throw new Error("This message is not at the start of a Codex turn");
    }
    this.forkPoint(item);
    return { canRewind: false, filesChanged: [], insertions: 0, deletions: 0 };
  }

  async rewind(item: UserItem, options: { files: boolean; draft?: boolean }): Promise<void> {
    if (options.files) throw new Error("Codex conversation rewind cannot restore files");
    this.requireHistoryIdle();
    await this.prepareSend();
    const fork = this.forkPoint(item);
    if (!fork.beforeTurnId) throw new Error("This message is not at the start of a Codex turn");
    this.rewinding = true;
    try {
      const copy = await this.forkThread(fork);
      this.flushNow();
      const thread = copy.thread as { id: string };
      if (this.currentThread() !== thread.id) throw new Error("Codex could not load the rewind");
      void this.request("thread/unsubscribe", { threadId: fork.threadId }).catch(() => {});
      this.readGoal(thread.id);
      this.showPicks();
      this.update((prev) => ({
        ...prev,
        card: undefined,
        goalClosed: undefined,
        ...(options.draft !== false
          ? { draft: { text: item.text, images: item.images, nonce: Date.now() } }
          : {}),
      }));
    } finally {
      this.rewinding = false;
    }
  }

  private async stage(fork: NonNullable<CodexTabTarget["fork"]>): Promise<boolean> {
    if (!fork.profileId || sameProfile(fork.profileId, this.target.profileId)) return false;
    try {
      const result = unwrapIpcResult(
        await ipcCallResult("chat", "stageThread", {
          workspaceId: this.target.workspaceId,
          threadId: fork.threadId,
          fromProfileId: fork.profileId,
          ...(this.target.profileId ? { toProfileId: this.target.profileId } : {}),
        }),
      );
      return result.found;
    } catch (err) {
      log.warn(`thread ${fork.threadId} not staged: ${(err as Error).message}`);
      return false;
    }
  }

  private readGoal(threadId: string | undefined): void {
    if (threadId) void this.request("thread/goal/get", { threadId }).catch(() => {});
  }

  async setGoalStatus(status: "active" | "paused"): Promise<void> {
    const threadId = this.currentThread();
    if (threadId) await this.ask("thread/goal/set", { threadId, status, origin: "user" });
  }

  async clearGoal(): Promise<void> {
    const threadId = this.currentThread();
    if (threadId) await this.ask("thread/goal/clear", { threadId });
  }

  async restart(): Promise<void> {
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    await (this.connectionRestart.whenIdle() ?? this.restartProgram());
  }

  profileConnectionChanged(profileId: string): void {
    if (this.profileId === profileId) this.connectionRestart.request(profileId);
  }

  private async restartProgram(connectionChanged = false): Promise<boolean> {
    const { workspaceId, tabId } = this.target;
    if (this.model.process === "running") {
      await stopChatProgram(workspaceId, tabId);
    }
    this.flushNow();
    return this.start(connectionChanged ? { connectionChanged } : {});
  }

  static async destinationForkSettings(
    target: Pick<CodexTabTarget, "workspaceId" | "cwd" | "profileId">,
    choices: ContinuedCodexChoices,
  ) {
    const controller = new CodexController({ ...target, tabId: crypto.randomUUID() });
    try {
      if (!(await controller.start({}, true))) {
        throw new Error(
          controller.state.error ?? "Codex could not resolve the destination profile",
        );
      }
      return await controller.resolveForkSettings(choices);
    } finally {
      await controller.close();
    }
  }

  private async resolveForkSettings(choices: ContinuedCodexChoices) {
    const defaults = await this.request("thread/start", { cwd: this.target.cwd, ephemeral: true });
    const id = (defaults.thread as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") throw new Error("Codex could not resolve the destination profile");
    try {
      const catalog =
        choices.model || choices.effort
          ? await this.request("model/list", {}).catch(() => undefined)
          : undefined;
      const models = codexModelsOf(catalog?.data);
      return profileForkSettings(defaults, choices, models);
    } finally {
      await this.request("thread/unsubscribe", { threadId: id }).catch(() => {});
    }
  }

  static async catalog(
    target: Omit<CodexTabTarget, "tabId">,
  ): Promise<Omit<ListedSession, "profileId">[]> {
    const controller = new CodexController({
      ...target,
      tabId: crypto.randomUUID(),
    });
    try {
      if (!(await controller.start({}, true))) {
        throw new Error(controller.state.error ?? "Codex could not list threads");
      }
      return await controller.readThreadList();
    } finally {
      await controller.close();
    }
  }

  static async savedThreadTurns(
    target: Pick<CodexTabTarget, "workspaceId" | "cwd" | "profileId">,
    threadIds: readonly string[],
    itemsView: "summary" | "full" = "summary",
  ): Promise<Map<string, unknown[]>> {
    const controller = new CodexController({ ...target, tabId: crypto.randomUUID() });
    const found = new Map<string, unknown[]>();
    try {
      if (!(await controller.start({}, true))) return found;
      if (!codexHistoryAvailable(codexServerVersion(controller.model, controller.state.version)))
        return found;
      for (const threadId of threadIds) {
        try {
          const read = (view: typeof itemsView) =>
            controller
              .request("thread/turns/list", { threadId, itemsView: view, limit: 1 })
              .catch(() => undefined);
          const page = (await read(itemsView)) ?? (itemsView === "full" && (await read("summary")));
          if (page) {
            if (Array.isArray(page.data) && page.data.length > 0) found.set(threadId, page.data);
            continue;
          }
          const turns = await controller.request("thread/turns/list", {
            threadId,
            itemsView: "notLoaded",
            limit: 1,
          });
          if (Array.isArray(turns.data) && turns.data.length > 0) found.set(threadId, []);
        } catch {}
      }
      return found;
    } finally {
      await controller.close();
    }
  }

  static async probePlanUsage(target: Pick<CodexTabTarget, "workspaceId" | "cwd" | "profileId">) {
    const controller = new CodexController({ ...target, tabId: crypto.randomUUID() });
    try {
      if (!(await controller.start({}, true))) {
        throw new Error(controller.state.error ?? "Codex could not read plan usage");
      }
      return await controller.readPlanUsage();
    } finally {
      await controller.close();
    }
  }

  private readPlanUsage(): Promise<Record<string, unknown>> {
    return this.request("account/rateLimits/read", {});
  }

  async listThreads(): Promise<Omit<ListedSession, "profileId">[]> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    return this.readThreadList(this.currentThread());
  }

  private async readThreadList(own?: string): Promise<Omit<ListedSession, "profileId">[]> {
    const cwd = this.target.cwd;
    const canonical = this.canonicalCwd ?? this.model.canonicalCwd;
    const aliases = canonical && canonical !== cwd ? [cwd, canonical] : [cwd];
    const lists = await Promise.all(
      aliases.map(async (directory) => {
        const result = await this.request("thread/list", {
          cwd: directory,
          sortKey: "updated_at",
          limit: THREAD_LIST_LIMIT,
          modelProviders: [],
          ...(own ? { excludedThreadIds: [own] } : {}),
        });
        return threadsOf(result.data);
      }),
    );
    const seen = new Set<string>();
    return lists
      .flat()
      .sort((a, b) => b.lastModified - a.lastModified)
      .filter((thread) => !seen.has(thread.sessionId) && seen.add(thread.sessionId))
      .slice(0, THREAD_LIST_LIMIT);
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId === this.currentThread()) throw new Error("the tab's own thread");
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    const read = await this.readThreadWhole(threadId).catch(() => null);
    const inherited = read ? await this.forkParentItems(threadId) : null;
    await readOpenHistories(this.target.workspaceId);
    await this.request("thread/delete", { threadId });
    if (!read || !inherited) return;
    const { workspaceId, cwd } = this.target;
    await removeConversationAttachments(workspaceId, codexThreadItems(read), cwd, inherited).catch(
      (error: Error) => log.warn(`removing thread ${threadId}'s attachments: ${error.message}`),
    );
  }

  private async forkParentItems(threadId: string): Promise<ChatItem[] | null> {
    const meta = await this.request("thread/read", { threadId, includeTurns: false }).catch(
      () => null,
    );
    const thread = meta?.thread as { forkedFromId?: unknown } | undefined;
    if (!thread) return null;
    const parent = thread.forkedFromId;
    if (parent === null || parent === undefined) return [];
    if (typeof parent !== "string") return null;
    const read = await this.readThreadWhole(parent).catch(() => null);
    return read ? codexThreadItems(read) : null;
  }

  private async readThreadWhole(threadId: string): Promise<unknown> {
    const thread = await readCodexThread(
      (method, params) => this.request(method, params),
      threadId,
      codexServerVersion(this.model, this.state.version),
    );
    return thread ? { thread } : null;
  }

  async resumeThread(
    threadId: string,
    title: string,
    profileId = this.profileId,
    emptyOnly = false,
  ): Promise<void> {
    const checkTarget = emptyOnly
      ? () => {
          if (profileId !== undefined && !sameProfile(profileId, this.target.profileId))
            throw new Error("use a tab with the conversation's profile, or resume in a new tab");
          if (
            this.model.items.some((item) => item.kind === "user" || item.kind === "assistant") ||
            this.state.queue.length > 0 ||
            (this.target.threadId && this.target.threadId !== this.emptyThread)
          )
            throw new Error("resume --tab requires an empty tab");
        }
      : undefined;
    this.requireHistoryIdle();
    await this.changeThread(async () => {
      const switching = !sameProfile(profileId, this.target.profileId);
      if (switching) {
        this.next = {};
        this.pickedPermissionMode = undefined;
      }
      this.target = {
        ...this.target,
        threadId,
        fork: undefined,
        moves: undefined,
        profileId: isDefaultProfileId(profileId) ? undefined : profileId,
      };
      this.titled = true;
      this.update((prev) => ({
        ...prev,
        history: null,
        queue: [],
        card: undefined,
        model: switching
          ? { ...emptyCodexModel(), lastSeq: this.model.lastSeq }
          : nextThreadModel(this.model),
      }));
      if (!(await this.start({ resetLog: true }))) {
        throw new Error(this.state.error ?? "Codex could not resume this thread");
      }
      if (switching) {
        this.hooks.onProfile?.(profileId);
        this.hooks.onChosen?.({});
      }
      this.hooks.onThread?.(threadId);
      this.hooks.onMoves?.([]);
      this.hooks.onTitle?.(this.model.threadName ?? title);
    }, checkTarget);
  }

  async newThread(): Promise<void> {
    await this.changeThread(
      async () => {
        const picks = { ...picksOf(this.model), ...this.next };
        this.next = picks;
        this.target = { ...this.target, threadId: undefined, fork: undefined, moves: undefined };
        this.titled = false;
        this.update((prev) => ({
          ...prev,
          history: null,
          queue: [],
          card: undefined,
          model: {
            ...nextThreadModel(this.model),
            model: picks.model,
            effort: picks.effort,
            permissionMode: picks.mode,
          },
        }));
        if (!(await this.start({ resetLog: true }))) {
          throw new Error(this.state.error ?? "Codex is not running");
        }
        const threadId = this.currentThread();
        if (threadId) this.hooks.onThread?.(threadId);
        this.hooks.onMoves?.([]);
        this.hooks.onTitle?.(this.model.threadName ?? "");
      },
      () => {
        if (this.model.running) throw new Error("a turn is running");
      },
    );
  }

  async switchProfile(profileId: string): Promise<void> {
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    if (sameProfile(profileId, this.target.profileId)) return;
    await this.changeThread(async () => {
      this.next = {};
      this.pickedPermissionMode = undefined;
      this.target = {
        ...this.target,
        threadId: undefined,
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
        model: { ...emptyCodexModel(), lastSeq: this.model.lastSeq },
      }));
      if (!(await this.start({ resetLog: true }))) {
        throw new Error(this.state.error ?? "Codex could not switch profiles");
      }
      this.hooks.onProfile?.(profileId);
      const threadId = this.currentThread();
      if (threadId) this.hooks.onThread?.(threadId);
      this.hooks.onTitle?.(this.model.threadName ?? "");
    });
  }

  private async changeThread(change: () => Promise<void>, checkTarget?: () => void): Promise<void> {
    if (
      this.disposed ||
      this.rewinding ||
      this.resumingSelection ||
      this.connectionRestart.active ||
      this.startup.pending ||
      this.startingTurn ||
      this.state.queue.some((item) => item.status === "sending")
    ) {
      throw new Error("Codex is changing the conversation");
    }
    this.resumingSelection = true;
    try {
      this.flushNow();
      checkTarget?.();
      if (this.model.process === "running") {
        await stopChatProgram(this.target.workspaceId, this.target.tabId);
      }
      this.flushNow();
      if (this.disposed) throw new Error("the tab closed");
      checkTarget?.();
      this.sandboxSessionId = crypto.randomUUID();
      const source = this.state;
      const sourceModel = this.model;
      const target = this.target;
      const next = this.next;
      const permissionMode = this.pickedPermissionMode;
      const titled = this.titled;
      const emptyThread = this.emptyThread;
      try {
        await change();
      } catch (error) {
        this.target = target;
        this.next = next;
        this.pickedPermissionMode = permissionMode;
        this.titled = titled;
        this.emptyThread = emptyThread;
        this.startup.failed = true;
        this.update((prev) => ({
          ...source,
          phase: "failed",
          error: (error as Error).message,
          model: {
            ...sourceModel,
            lastSeq: Math.max(sourceModel.lastSeq, prev.model.lastSeq),
            process: "exited",
            running: false,
            turn: null,
            turnId: undefined,
            permissions: [],
          } satisfies CodexModel,
        }));
        throw error;
      }
    } finally {
      this.resumingSelection = false;
    }
  }

  async continueInProfile(profileId: string): Promise<void> {
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    if (sameProfile(profileId, this.target.profileId)) return;
    this.flushNow();
    const threadId = this.currentThread();
    if (!threadId || (this.model.process === "running" && this.model.items.length === 0)) {
      await this.switchProfile(profileId);
      return;
    }
    const { workspaceId, cwd } = this.target;
    const sourceProfile = this.profileId;
    const forkSettings = await CodexController.destinationForkSettings(
      { workspaceId, cwd, profileId },
      {
        model: this.next.model,
        effort: this.next.effort,
        readOnly: this.pickedPermissionMode === "readOnly",
      },
    );
    if (sourceProfile !== this.profileId || threadId !== this.currentThread()) {
      throw new Error("The Codex source thread changed while resolving the destination profile");
    }
    await this.changeThread(async () => {
      const after = lastMessageId(this.model.items.filter((item) => item.kind === "assistant"));
      const moves = after
        ? withMove(this.target.moves, { profileId, after, at: Date.now() })
        : [...(this.target.moves ?? [])];
      this.next = {};
      this.pickedPermissionMode = undefined;
      const title = this.model.threadName;
      this.target = {
        ...this.target,
        threadId: undefined,
        fork: {
          threadId,
          ...(title ? { title } : {}),
          profileId: this.target.profileId ?? defaultProfileId("codex"),
        },
        profileId: isDefaultProfileId(profileId) ? undefined : profileId,
        moves,
      };
      this.update((prev) => ({
        ...prev,
        history: null,
        queue: [],
        card: undefined,
        model: { ...emptyCodexModel(), lastSeq: this.model.lastSeq },
      }));
      if (!(await this.start({ resetLog: true }, false, forkSettings))) {
        throw new Error(this.state.error ?? "Codex could not continue in the destination profile");
      }
      this.hooks.onProfile?.(profileId);
      const copy = this.currentThread();
      if (copy) this.hooks.onThread?.(copy);
      if (title) this.hooks.onTitle?.(title);
      this.hooks.onMoves?.(moves);
    });
  }

  async ask(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    return this.request(method, params);
  }

  async listMcpServers(): Promise<CodexMcpServer[]> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    this.flushNow();
    const threadId = this.currentThread();
    const request = {};
    this.mcpRead = request;
    const ready = this.ready;
    const servers: CodexMcpServer[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        ...(threadId ? { threadId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      servers.push(...mcpServersOf(result));
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated MCP cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.flushNow();
    if (
      this.mcpRead === request &&
      this.ready === ready &&
      this.currentThread() === threadId &&
      this.model.process === "running"
    ) {
      this.patchModel({ mcpServers: servers });
    }
    return servers;
  }

  async setServiceTier(threadId: string, serviceTier: string): Promise<void> {
    const { model, effort } = this.next;
    await this.ask("thread/settings/update", {
      threadId,
      serviceTier,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    if (this.currentThread() === threadId) this.patchModel({ serviceTier });
  }

  private probeCollaborationModes() {
    this.collaborationProbe ??= this.request("collaborationMode/list", {}, 5_000).then(
      (result) => collaborationPresetsOf(result.data),
      () => collaborationPresetsOf(undefined),
    );
    return this.collaborationProbe;
  }

  async availableCollaborationModes() {
    if (!(await this.introduced)) return false;
    const presets = await this.probeCollaborationModes();
    this.flushNow();
    return !!presets.plan && !!presets.default;
  }

  async setCollaborationMode(mode: CodexCollaborationMode): Promise<void> {
    if (this.collaborationChange) throw new Error("Codex is already changing collaboration mode");
    const change = this.changeCollaborationMode(mode);
    this.collaborationChange = change;
    try {
      await change;
    } finally {
      this.collaborationChange = undefined;
    }
  }

  private async changeCollaborationMode(mode: CodexCollaborationMode): Promise<void> {
    await this.prepareSend();
    if (!(await this.availableCollaborationModes())) {
      throw new Error("This Codex server does not offer Plan and Default modes");
    }
    const threadId = this.currentThread();
    const ready = this.ready;
    if (!threadId) throw new Error("Codex has no thread");
    if (this.model.collaborationMode === mode) return;
    const result = await this.request("config/read", { cwd: this.target.cwd });
    if (this.ready !== ready || this.currentThread() !== threadId) {
      throw new Error("The Codex thread changed");
    }
    const config = result.config as Record<string, unknown> | undefined;
    const { model, collaborationPresets, collaborationSettings } = this.model;
    if (!model) throw new Error("Codex did not tell this thread's model");
    const previous = collaborationSettings?.[mode];
    const configEffort =
      mode === "plan" ? config?.plan_mode_reasoning_effort : config?.model_reasoning_effort;
    const configured = typeof configEffort === "string" ? configEffort : undefined;
    const fallback = previous
      ? previous.reasoning_effort
      : (configured ?? collaborationPresets?.[mode]?.effort ?? null);
    const effort = this.next.effort ?? (mode === "plan" ? configured : undefined) ?? fallback;
    await this.request("thread/settings/update", {
      threadId,
      collaborationMode: {
        mode,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions:
            config?.include_collaboration_mode_instructions === false
              ? ""
              : (previous?.developer_instructions ?? null),
        },
      },
    });
    this.flushNow();
    if (this.ready !== ready || this.currentThread() !== threadId) {
      throw new Error("The Codex thread changed");
    }
    this.showPicks();
  }

  showCard(card: Omit<CommandCard, "id">): string {
    const id = nextId();
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

  currentThread(): string | undefined {
    return this.model.threadId ?? this.target.threadId;
  }

  get sandboxSession(): string | null {
    this.flushNow();
    return this.disposed || this.resumingSelection || this.rewinding ? null : this.sandboxSessionId;
  }

  private rememberThread(threadId: string): void {
    if (threadId === this.target.threadId) return;
    if (this.target.threadId && !this.resumingSelection)
      this.sandboxSessionId = crypto.randomUUID();
    this.target = { ...this.target, threadId, fork: undefined };
    if (!this.resumingSelection) this.hooks.onThread?.(threadId);
  }

  async refreshAccount(): Promise<void> {
    if (!(await this.ensureRunning())) return;
    await this.request("account/read", {}).catch(() => {});
    forgetPlanWait(this.usageKey());
    this.readRateLimits();
  }

  private readRateLimits(): void {
    this.limitsReadable = true;
    void wantPlanUsage(this.usageKey());
  }

  private replay(afterSeq?: number): Promise<ReplayResult> {
    return replayTab(
      {
        target: this.target,
        live: this.live,
        disposed: () => this.disposed,
        lastSeq: () => this.model.lastSeq,
        flushNow: () => this.flushNow(),
        keep: (lines) => this.buffered.push(...lines),
      },
      afterSeq,
    );
  }

  async resync(): Promise<void> {
    this.flushNow();
    let replay: ReplayResult;
    try {
      replay = await this.replay(this.model.lastSeq);
    } catch {
      return;
    }
    if (replay.found) {
      this.update((prev) => ({ ...prev, phase: replay.running ? "ready" : "ended" }));
      if (replay.running) this.sendNextQueued();
      if (replay.running && (this.discoverAgents || this.dirtyAgents.size > 0)) {
        this.armSubagentRefresh();
      }
      return;
    }
    this.limitsReadable = false;
    this.ready = Promise.resolve(false);
    this.canonicalCwd = undefined;
    this.deferToolSendsForTurn = undefined;
    this.update((prev) => ({
      ...prev,
      phase: "ended",
      model: loseCodexLog(this.model),
      queue: prev.queue.map((item) =>
        item.afterTool !== undefined && item.status !== "sending"
          ? { ...item, afterTool: 0 }
          : item,
      ),
    }));
    this.rejectPending("the program is gone");
  }

  held(): void {
    this.update(heldTab);
  }

  async prepareSend(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    if (!(await this.ready)) throw new Error(this.state.error ?? "Codex has no thread to send to");
    this.flushNow();
  }

  async send(text: string, images: ImageBlock[] = [], from?: RelaySender): Promise<void> {
    await this.sendMessage(text, images, { from });
  }

  async sendNow(text: string, images: ImageBlock[] = []): Promise<void> {
    await this.sendMessage(text, images, { now: true });
  }

  async sendWithTiming(
    text: string,
    images: ImageBlock[],
    timing: "next" | "now",
    from?: RelaySender,
    device?: string,
    id?: string,
  ): Promise<string | undefined> {
    return (await this.sendMessage(text, images, { now: timing === "now", from, id, device }))
      ?.heldId;
  }

  private turnModelSettings(model: string | undefined, effort: string | undefined) {
    const connection = this.connection;
    if (connection?.method !== "custom") {
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    }
    const selected = model ?? this.model.model;
    const choice =
      connection.models.find(({ id }) => id === selected) ??
      connection.models.find(({ id }) => id === connection.defaultModel);
    if (!choice) return {};
    if (!choice.reasoning || choice.reasoning === "none") {
      const mode = this.model.collaborationMode ?? "default";
      return {
        collaborationMode: {
          mode,
          settings: {
            model: choice.id,
            reasoning_effort: null,
            developer_instructions:
              this.model.collaborationSettings?.[mode]?.developer_instructions ?? null,
          },
        },
      };
    }
    const chosenEffort = effort ?? this.model.effort;
    const allowed = connectionReasoningLevels(choice.reasoning);
    return {
      model: choice.id,
      effort: chosenEffort && allowed.includes(chosenEffort) ? chosenEffort : "low",
    };
  }

  private async sendMessage(
    text: string,
    images: ImageBlock[],
    {
      from,
      id,
      device,
      now,
      queued,
    }: {
      from?: RelaySender;
      id?: string;
      device?: string;
      now?: boolean;
      queued?: QueuedMessage;
    },
  ): Promise<{ heldId: string; afterTurn?: true } | undefined> {
    const collaboration = this.collaborationChange;
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    if (!(await this.ensureRunning())) throw new Error(this.state.error ?? "Codex is not running");
    if (!(await this.ready)) throw new Error(this.state.error ?? "Codex has no thread to send to");
    const pendingMode = collaboration ?? this.collaborationChange;
    if (pendingMode) await pendingMode;
    this.flushNow();
    if (now && !this.model.turnId && this.startingTurn) {
      await this.startingTurn.catch(() => {});
    }
    const restart = this.connectionRestart.whenIdle();
    if (restart && !(await this.connectionRestart.wait(restart)))
      throw new Error(this.state.error ?? "Codex is not running");
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    if (queued && !this.state.queue.some((entry) => entry.id === id && entry.status === "sending"))
      throw new Error("The conversation changed while delivering a queued message");
    const { running, turnId } = this.model;
    if (queued && !this.canSendQueued(queued)) return { heldId: queued.id };
    if (!queued && ((this.startingTurn && !turnId) || (running && (!now || !turnId)))) {
      return {
        heldId: this.holdMessage(
          text,
          images,
          from,
          device,
          id,
          now ? undefined : this.model.lastSeq,
        ),
      };
    }
    const threadId = this.model.threadId;
    if (!threadId) throw new Error("Codex has no thread to send to");
    this.emptyThread = undefined;
    const said = from && text ? relayedText(from, text) : text;
    const input = [
      ...(said ? [{ type: "text", text: said, text_elements: [] }] : []),
      ...images.map((image) => ({
        type: "image",
        url: `data:${image.mediaType};base64,${image.data}`,
      })),
    ];
    if (!this.titled && text.trim()) {
      this.titled = true;
      if (!this.model.items.some((item) => item.kind === "user")) {
        this.hooks.onFirstMessage?.(shownUserText(text).trim());
      }
    }
    const clientUserMessageId = queued?.clientUserMessageId ?? (id ? `peer-${id}` : nextId());
    const record = from ? { id: clientUserMessageId, from, at: Date.now() } : undefined;
    if (record) this.hooks.onRelayed?.(record);
    const told = (result: Record<string, unknown>, fallback?: string) => {
      const turn = turnIdOf(result) ?? fallback;
      if (record && turn) this.hooks.onRelayed?.({ ...record, turnId: turn });
    };
    if (running && turnId) {
      try {
        const result = await this.request("turn/steer", {
          threadId,
          clientUserMessageId,
          input,
          expectedTurnId: turnId,
        });
        told(result, turnId);
        return;
      } catch (err) {
        if (!(err instanceof CodexReplyError)) throw err;
        this.flushNow();
        log.info(`steer not taken: ${(err as Error).message}`);
        if (this.model.running) {
          if (queued) {
            this.deferToolSendsForTurn = this.model.turnId;
            return { heldId: queued.id, afterTurn: true };
          }
          return {
            heldId: this.holdMessage(
              text,
              images,
              from,
              device,
              id ?? clientUserMessageId,
              undefined,
              clientUserMessageId,
            ),
          };
        }
      }
    }
    const { model, effort, mode } = this.next;
    this.turnPicks = { threadId, clientId: clientUserMessageId, picks: this.next };
    const { reply, written } = this.requestWithWrite("turn/start", {
      threadId,
      clientUserMessageId,
      input,
      ...this.turnModelSettings(model, effort),
      ...(mode ? MODE_SETTINGS[mode] : {}),
    });
    const start = reply
      .then(
        (result) => {
          this.confirmTurnPicks(clientUserMessageId);
          told(result);
        },
        async (error: unknown) => {
          if (
            this.turnPicks?.clientId === clientUserMessageId &&
            (error instanceof CodexReplyError || isChatWriteRejected(error))
          ) {
            this.turnPicks = undefined;
          }
          if (!id && error instanceof CodexReplyError) {
            await written.then(
              () => {
                const failed: QueuedMessage = {
                  id: clientUserMessageId,
                  text,
                  images,
                  ...(from ? { from } : {}),
                  ...(device ? { device } : {}),
                  status: "failed",
                  error: error.message.slice(0, 1000),
                };
                this.update((prev) => ({ ...prev, queue: [...prev.queue, failed] }));
              },
              () => {},
            );
          }
          throw error;
        },
      )
      .finally(() => {
        this.flushNow();
        this.startingTurn = undefined;
        this.sendNextQueued();
      });
    this.startingTurn = start;
    if (id) await start;
    else {
      void start.catch(() => {});
      await written;
      this.flushNow();
    }
  }

  private confirmTurnPicks(clientId: string): void {
    const sent = this.turnPicks;
    if (sent?.clientId !== clientId || sent.threadId !== this.currentThread()) return;
    this.turnPicks = undefined;
    const latest = this.next;
    const model = latest.model === sent.picks.model ? undefined : latest.model;
    const effort = latest.effort === sent.picks.effort ? undefined : latest.effort;
    const mode = latest.mode === sent.picks.mode ? undefined : latest.mode;
    this.next = {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(mode !== undefined ? { mode } : {}),
    };
    if (model !== latest.model || effort !== latest.effort) {
      this.hooks.onChosen?.({ model, effort });
    }
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
    return this.holdMessage(text, images, from, device, id);
  }

  private holdMessage(
    text: string,
    images: ImageBlock[],
    from?: RelaySender,
    device?: string,
    id?: string,
    afterTool?: number,
    clientUserMessageId?: string,
  ): string {
    if (this.rewinding || this.resumingSelection)
      throw new Error("Codex is changing the conversation");
    const item: QueuedMessage = {
      id: id ?? nextId(),
      text,
      images,
      ...(afterTool !== undefined ? { afterTool } : {}),
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(from ? { from } : {}),
      ...(device ? { device } : {}),
    };
    this.update((prev) => ({ ...prev, queue: [...prev.queue, item] }));
    this.sendNextQueued();
    return item.id;
  }

  removeQueued(id: string): QueuedMessage | undefined {
    return removeQueuedIn(this.state, (change) => this.update(change), id);
  }

  editQueued(id: string, text: string, device?: string, from?: RelaySender): boolean {
    return editQueuedIn(this.state, (change) => this.update(change), id, text, device, from);
  }

  private sendNextQueued(): void {
    if (this.resumingSelection || this.connectionRestart.whenIdle()) return;
    dispatchQueuedMessage(
      this.state.queue,
      (update) => this.update(update),
      async (next) => {
        const offset = this.model.logSeqOffset;
        const held = await this.sendMessage(next.text, next.images, {
          from: next.from,
          id: next.id,
          queued: next,
        });
        if (!held) return;
        if (held.afterTurn) return { ...next, afterTool: undefined };
        if (next.afterTool !== undefined && offset !== this.model.logSeqOffset)
          return { ...next, afterTool: 0 };
        return next;
      },
      (error) => error instanceof CodexReplyError || isChatWriteRejected(error),
      (id) => this.sawQueuedMessage(id),
      () => this.sendNextQueued(),
      (item) => this.canSendQueued(item),
    );
  }

  private canSendQueued(item: QueuedMessage): boolean {
    if (this.disposed || this.startingTurn || this.state.phase === "held") return false;
    const { running, turnId, toolCompletedSeq, permissions, interrupting } = this.model;
    if (!running) return true;
    return (
      turnId !== undefined &&
      turnId !== this.deferToolSendsForTurn &&
      turnId !== this.stoppingTurn &&
      !interrupting &&
      permissions.length === 0 &&
      item.afterTool !== undefined &&
      toolCompletedSeq !== undefined &&
      toolCompletedSeq > item.afterTool
    );
  }

  private sawQueuedMessage(id: string): boolean {
    const clientId =
      this.state.queue.find((item) => item.id === id)?.clientUserMessageId ?? `peer-${id}`;
    return this.model.items.some(
      (item) => item.kind === "user" && item.key === `u-${clientId}` && item.state === "taken",
    );
  }

  async interrupt(): Promise<unknown> {
    this.flushNow();
    const threadId = this.model.threadId;
    if (!this.model.turnId && this.startingTurn) {
      await this.startingTurn;
      this.flushNow();
    }
    const { turnId, running } = this.model;
    if (!threadId || threadId !== this.model.threadId || !turnId || !running) {
      throw new Error("Codex has no running turn to interrupt");
    }
    this.stoppingTurn = turnId;
    const { reply, key } = this.requestWithWrite("turn/interrupt", { threadId, turnId });
    try {
      return await reply;
    } catch (error) {
      this.flushNow();
      if (this.model.interruptRequestId === key) {
        this.patchModel({ interrupting: false, interruptRequestId: undefined });
      }
      throw error;
    } finally {
      if (this.stoppingTurn === turnId) this.stoppingTurn = undefined;
      this.flushNow();
      this.sendNextQueued();
    }
  }

  async setPermissionMode(mode: string): Promise<unknown> {
    if (!(mode in MODE_SETTINGS)) throw new Error(`unknown mode ${mode}`);
    this.pickedPermissionMode = mode as CodexMode;
    this.next = { ...this.next, mode: this.pickedPermissionMode };
    this.patchModel({ permissionMode: mode });
    return undefined;
  }

  async setModel(model: string): Promise<unknown> {
    this.next = { ...this.next, model };
    this.patchModel({ model });
    this.hooks.onChosen?.({ model });
    return undefined;
  }

  async setEffort(level: string): Promise<unknown> {
    this.next = { ...this.next, effort: level };
    this.patchModel({ effort: level });
    this.hooks.onChosen?.({ effort: level });
    return undefined;
  }

  inheritedInstructions(): { instructions?: string } {
    const instructions = this.hooks.instructions?.(this.currentThread());
    return instructions ? { instructions } : {};
  }

  inheritedChoice(): ChatChosen | undefined {
    const { model, effort } = { ...picksOf(this.model), ...this.next };
    return model || effort
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      : undefined;
  }

  private showPicks(): void {
    const { model, effort } = this.next;
    if (!model && !effort) return;
    this.flushNow();
    this.patchModel({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }

  private async configSnapshot(remote: boolean) {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    this.flushNow();
    const models = this.model.init?.models;
    const [result, requirements, catalog] = await Promise.all([
      this.request("config/read", { cwd: this.target.cwd, includeLayers: true }),
      this.request("configRequirements/read", {}).catch((error: Error & { code?: number }) => {
        if (
          error.code === -32601 ||
          (error.code === -32600 &&
            error.message.includes("unknown variant `configRequirements/read`"))
        )
          return undefined;
        throw error;
      }),
      models ?? this.request("model/list", {}).then((result) => codexModelsOf(result.data)),
    ]);
    return codexConfigSnapshot(
      result,
      requirements,
      catalog,
      remote,
      this.model.model,
      codexServerVersion(this.model, this.state.version),
    );
  }

  async cliSandbox() {
    this.flushNow();
    if (this.state.phase !== "ready" || this.model.process !== "running") return null;
    const ready = this.ready;
    let current = this.model.sandboxMode;
    if (current === undefined) {
      const { config } = await this.request("config/read", { cwd: this.target.cwd });
      const effective = config as { sandbox_mode?: unknown; default_permissions?: unknown } | null;
      this.flushNow();
      if (this.ready !== ready || this.model.process !== "running") return null;
      current = this.model.sandboxMode;
      if (current === undefined && effective?.default_permissions == null) {
        current = modeOf(effective?.sandbox_mode);
      }
    }
    return {
      agent: "codex" as const,
      current: current ?? undefined,
      next: this.pickedPermissionMode ?? current ?? undefined,
      running: this.model.running,
    };
  }

  async readDefaults(remote = false) {
    const profileId = this.profileId;
    const { shown } = await this.configSnapshot(remote);
    if (profileId !== this.profileId) throw new CodexConfigRefusal("The Codex profile changed");
    shown.keys.push({
      key: CODEX_CONFIG_PROFILE_KEY,
      group: "other",
      kind: "choice",
      options: [],
      value: profileId,
    });
    return shown;
  }

  async saveDefaults(set: CodexConfigSet, remote = false): Promise<void> {
    const profileId = this.profileId;
    const { [CODEX_CONFIG_PROFILE_KEY]: expectedProfileId, ...changes } = set.changes;
    if (expectedProfileId !== undefined && expectedProfileId !== profileId) {
      throw new CodexConfigRefusal(
        "The Codex profile changed. Reopen the defaults for this profile.",
      );
    }
    const snapshot = await this.configSnapshot(remote);
    if (profileId !== this.profileId) {
      throw new CodexConfigRefusal("The Codex profile changed while reading defaults");
    }
    const edits = codexConfigEdits({ ...set, changes }, snapshot, remote);
    if (!edits.length) return;
    const result = await this.request("config/batchWrite", {
      edits,
      ...(snapshot.filePath ? { filePath: snapshot.filePath } : {}),
      ...(snapshot.version ? { expectedVersion: snapshot.version } : {}),
    });
    if (result.status === "okOverridden") {
      throw new Error("Codex saved the defaults, but another config layer overrides a saved value");
    }
    if (result.status !== "ok") throw new Error("Codex did not confirm the config write");
    if (profileId !== this.profileId) return;
    for (const { keyPath, value } of edits) {
      if (typeof value !== "string") continue;
      if (keyPath === "model") await this.setModel(value);
      if (keyPath === "model_reasoning_effort") await this.setEffort(value);
    }
  }

  private patchModel(patch: Partial<CodexModel>): void {
    this.update((prev) => ({ ...prev, model: { ...prev.model, ...patch } }));
  }

  supports(subtype: string): boolean {
    return SUPPORTED.has(subtype);
  }

  async fileSuggestions(query: string): Promise<string[]> {
    const { phase } = this.state;
    if (phase !== "ready" || this.model.process !== "running" || !query) return [];
    const result = await this.request("fuzzyFileSearch", {
      query,
      roots: [this.target.cwd],
      cancellationToken: null,
    });
    return suggestedPaths(result.files);
  }

  attach(name: string, data: string): Promise<string> {
    return attachToTab(this.target, name, data);
  }

  async answerPermission(request: PermissionRequest, answer: PermissionAnswer): Promise<void> {
    this.flushNow();
    if (!this.model.permissions.includes(request)) return;
    const asked = this.model.requests[request.requestId];
    if (!asked) return;
    const id = JSON.parse(request.requestId) as string | number;
    const result = answerOf(asked.method, asked.params, answer);
    await this.write({ id, result });
    if (answer.kind === "deny-stop" && asked.method === "item/permissions/requestApproval") {
      this.flushNow();
      const { threadId, turnId, running } = this.model;
      if (running && turnId && threadId === asked.params.threadId && turnId === asked.params.turnId)
        await this.interrupt();
    }
    const message = answer.kind === "deny" ? answer.message : undefined;
    if (message) await this.sendNow(message).catch(() => {});
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return this.requestWithWrite(method, params, timeoutMs).reply;
  }

  private requestWithWrite(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): { written: Promise<void>; reply: Promise<Record<string, unknown>>; key: string } {
    const id = nextId();
    const key = idKey(id) as string;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });
    const written = this.write({ id, method, params });
    void written.catch((err: Error) => {
      const entry = this.pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(key);
      entry.reject(err);
    });
    if (HISTORY_MUTATIONS.has(method)) {
      const reply = promise.then((result) => {
        invalidateCodexHistory(this.target.workspaceId);
        return result;
      });
      return { reply, written, key };
    }
    return { reply: promise, written, key };
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (this.disposed) throw new Error("the tab closed");
    const { workspaceId, tabId } = this.target;
    const turn = message.method === "turn/start";
    unwrapIpcResult(
      await ipcCallResult("chat", "send", {
        workspaceId,
        tabId,
        message,
        ...(turn && this.target.profileId ? { profileId: this.target.profileId } : {}),
        ...(turn && this.hooks.instructions
          ? { instructions: this.hooks.instructions(this.currentThread()) }
          : {}),
      }),
    );
  }

  private async ensureRunning(): Promise<boolean> {
    if (this.disposed || this.resumingSelection) return false;
    if (this.opening) {
      await this.opening;
      if (this.state.phase === "failed") return false;
    }
    if (this.startup.pending) return this.startup.pending;
    this.flushNow();
    const restart = this.connectionRestart.whenIdle();
    if (restart) return this.connectionRestart.wait(restart);
    const { phase } = this.state;
    if (phase === "ready" && this.model.process === "running") return this.introduced;
    if (phase === "held" || phase === "not-found") return false;
    return (await this.start({})) && (await this.introduced);
  }

  loadSubagent(id: string): Promise<void> {
    const known = this.readingAgents.get(id);
    if (known) return known;
    if (this.state.phase !== "ready" || this.model.tasks[id]?.type !== "codex_subagent")
      return Promise.resolve();
    if (this.subagentReadDelay(id) > 0) return Promise.resolve();
    const parent = this.model.threadId;
    this.readAgentAt.set(id, Date.now());
    const read = this.request("thread/read", { threadId: id, includeTurns: true })
      .then((result) => {
        this.flushNow();
        const child = result.thread as { id?: unknown; updatedAt?: unknown } | undefined;
        if (
          this.model.threadId === parent &&
          child?.id === id &&
          typeof child.updatedAt === "number"
        ) {
          this.readAgentVersion.set(id, child.updatedAt);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.readingAgents.get(id) !== read) return;
        this.readingAgents.delete(id);
        if (this.dirtyAgents.has(id)) this.armSubagentRefresh();
      });
    this.readingAgents.set(id, read);
    return read;
  }

  private subagentReadDelay(id: string): number {
    return (this.readAgentAt.get(id) ?? -Infinity) + 2_000 - Date.now();
  }

  private scheduleSubagents(childId?: string): void {
    if (childId) this.dirtyAgents.add(childId);
    else this.discoverAgents = true;
    this.armSubagentRefresh();
  }

  private armSubagentRefresh(delay = 400): void {
    if (this.disposed || this.refreshingAgents || this.agentRefresh !== undefined) return;
    this.agentRefresh = setTimeout(() => {
      this.agentRefresh = undefined;
      void this.refreshSubagents();
    }, delay);
  }

  private async refreshSubagents(): Promise<void> {
    if (this.refreshingAgents || this.disposed) return;
    this.refreshingAgents = true;
    try {
      this.flushNow();
      const threadId = this.model.threadId;
      if (!threadId || this.state.phase !== "ready") return;
      if (this.discoverAgents) {
        this.discoverAgents = false;
        await this.discoverSubagents(threadId);
      }
      if (this.model.threadId !== threadId || this.disposed) return;

      for (const id of this.dirtyAgents) {
        if (this.model.tasks[id]?.type !== "codex_subagent") {
          this.dirtyAgents.delete(id);
          continue;
        }
        if (this.readingAgents.has(id) || this.subagentReadDelay(id) > 0) continue;
        this.dirtyAgents.delete(id);
        void this.loadSubagent(id);
      }
    } finally {
      this.refreshingAgents = false;
      if (this.state.phase === "ready" && this.model.threadId) {
        let next = this.discoverAgents ? 400 : Infinity;
        for (const id of this.dirtyAgents) {
          if (!this.readingAgents.has(id)) next = Math.min(next, this.subagentReadDelay(id));
        }
        if (Number.isFinite(next)) this.armSubagentRefresh(Math.max(400, next));
      }
    }
  }

  private async discoverSubagents(threadId: string): Promise<void> {
    const changed = new Set<string>();
    if (codexHistoryAvailable(codexServerVersion(this.model, this.state.version))) {
      const before = this.model.tasks;
      const result = await this.request("thread/list", {
        parentThreadId: threadId,
        sourceKinds: ["subAgentThreadSpawn"],
        sortKey: "updated_at",
        limit: 20,
      }).catch(() => undefined);
      this.flushNow();
      if (this.model.threadId !== threadId || this.disposed) return;
      for (const raw of Array.isArray(result?.data) ? result.data : []) {
        const child = raw as { id?: unknown; updatedAt?: unknown } | null;
        if (
          typeof child?.id === "string" &&
          ((typeof child.updatedAt === "number" &&
            child.updatedAt !== this.readAgentVersion.get(child.id)) ||
            (before[child.id]?.status === "running" &&
              this.model.tasks[child.id]?.status !== "running"))
        ) {
          changed.add(child.id);
        }
      }
    }
    const children = Object.values(this.model.tasks)
      .filter((task) => task.type === "codex_subagent")
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 20);
    for (const { taskId } of children) {
      if (!this.model.nativeTranscripts?.[taskId] || changed.has(taskId))
        this.dirtyAgents.add(taskId);
    }
  }

  receive(line: ChatLine): void {
    if (this.disposed) return;
    this.inspectLine(line);
    if (this.live.holds(line)) return;
    this.buffered.push(line);
    if (this.hooks.onTurnEnd && liveCodexResultThread(line)) this.flushNow();
    else if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flushNow(), 16);
  }

  private inspectLine(line: ChatLine): void {
    const message = line.message as Record<string, unknown> | undefined;
    if (line.dir !== "out" || !message) return;
    const key = idKey(message.id);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (key && !method) {
      const entry = this.pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(key);
      const error = message.error as { message?: unknown; code?: unknown } | undefined;
      if (error) {
        entry.reject(
          Object.assign(new CodexReplyError(String(error.message ?? "error")), {
            code: error.code,
          }),
        );
      } else entry.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }
    if (line.replay) return;
    if (key && method && !CARD_REQUESTS.has(method)) {
      const reply =
        method === "mcpServer/elicitation/request"
          ? { id: message.id, result: { action: "decline", content: null, _meta: null } }
          : { id: message.id, error: UNSUPPORTED };
      void this.write(reply).catch(() => {});
      return;
    }
    const params = message.params as
      | {
          threadId?: string;
          item?: { type?: string; agentThreadId?: unknown; receiverThreadIds?: unknown };
          status?: { type?: unknown };
        }
      | undefined;
    const from = params?.threadId;
    if (from && from === this.model.threadId && method === "turn/completed") {
      invalidateCodexHistory(this.target.workspaceId);
    }
    const childBecameIdle =
      isThreadStatusChanged(method) &&
      (params?.status?.type === "idle" || params?.status?.type === "systemError");
    if (
      (method === "item/completed" || method === "turn/completed" || childBecameIdle) &&
      from &&
      this.model.tasks[from]?.type === "codex_subagent"
    ) {
      this.scheduleSubagents(from);
    }
    if (method === "item/completed" && from === this.model.threadId) {
      const item = params?.item;
      const children =
        item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds
          : item?.type === "subAgentActivity"
            ? [item.agentThreadId]
            : [];
      for (const id of children) {
        if (typeof id !== "string" || id === from) continue;
        if (this.model.tasks[id]?.type !== "codex_subagent") this.scheduleSubagents();
        this.scheduleSubagents(id);
      }
    }
    if (method === "account/login/completed") void this.refreshAccount();
    if (method === "account/rateLimits/updated") {
      const params = message.params as Record<string, unknown> | undefined;
      ingestCodexPush(this.usageKey(), params?.rateLimits, Date.now());
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
    const before = this.model;
    const model = applyCodexLines(before, lines, undefined, this.state.version);
    if (model === before) return;
    if (model.running || model.lastResult) this.emptyThread = undefined;
    this.update((prev) => ({ ...prev, model, phase: phaseAfter(prev.phase, model) }));
    const pendingPick = this.turnPicks;
    if (
      pendingPick &&
      model.items !== before.items &&
      model.items.some(
        (item) =>
          item.kind === "user" &&
          item.key === `u-${pendingPick.clientId}` &&
          item.state === "taken",
      )
    ) {
      this.confirmTurnPicks(pendingPick.clientId);
    }
    if (model.threadId) this.rememberThread(model.threadId);
    if (
      model.lastResult !== before.lastResult &&
      model.threadId &&
      lines.some((line) => liveCodexResultThread(line) === model.threadId)
    )
      this.hooks.onTurnEnd?.(model);
    if (model.threadId && model.threadId !== before.threadId) {
      this.dirtyAgents.clear();
      this.readAgentAt.clear();
      this.readAgentVersion.clear();
      this.readingAgents.clear();
      this.scheduleSubagents();
    }
    if (model.threadName && model.threadName !== before.threadName) {
      this.titled = true;
      if (!this.resumingSelection) this.hooks.onTitle?.(model.threadName);
    }
    if (
      model.items !== before.items &&
      this.state.queue.some((item) => item.status === "unconfirmed")
    )
      this.update((prev) => clearObservedQueued(prev, (id) => this.sawQueuedMessage(id)));
    if ((before.running && !model.running) || before.toolCompletedSeq !== model.toolCompletedSeq) {
      this.sendNextQueued();
    }
    if (before.running && !model.running) {
      if (
        Object.values(model.tasks).some(
          (task) => task.type === "codex_subagent" && task.status === "running",
        )
      ) {
        this.scheduleSubagents();
      }
    }
    if (model.process === "exited" && before.process !== "exited") {
      this.limitsReadable = false;
      this.ready = Promise.resolve(false);
      this.rejectPending("the program exited");
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
    clearTimeout(this.agentRefresh);
    this.removeReceiver();
    this.leavePlanUsage();
    useChatStore.getState().remove(this.key);
    controllers.delete(this.key);
  }
}

const SANDBOX_MODES: Record<CodexMode, string> = {
  readOnly: "read-only",
  auto: "workspace-write",
  fullAccess: "danger-full-access",
};

const CARD_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

export interface CodexPicks {
  model?: string;
  effort?: string;
  mode?: CodexMode;
}

function savedProfileConnection(profileId: string | undefined): ProfileConnection | undefined {
  return profileOf(useAgentProfilesStore.getState().config, "codex", profileId).connection;
}

function picksFrom(chosen: ChatChosen | undefined): CodexPicks {
  return {
    ...(chosen?.model ? { model: chosen.model } : {}),
    ...(chosen?.effort ? { effort: chosen.effort } : {}),
  };
}

export function picksOf(model: CodexModel): CodexPicks {
  const { permissionMode } = model;
  return {
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(permissionMode && permissionMode in MODE_SETTINGS
      ? { mode: permissionMode as CodexMode }
      : {}),
  };
}

export function threadStartParams(
  target: CodexTabTarget,
  picks: CodexPicks,
): Record<string, unknown> {
  return {
    cwd: target.cwd,
    ...(picks.effort ? { config: { model_reasoning_effort: picks.effort } } : {}),
    ...(picks.model ? { model: picks.model } : {}),
    ...(picks.mode
      ? {
          approvalPolicy: MODE_SETTINGS[picks.mode].approvalPolicy,
          sandbox: SANDBOX_MODES[picks.mode],
        }
      : {}),
  };
}

const IN_GIT = /(^|[\\/])\.git([\\/]|$)/;

export function suggestedPaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .flatMap((raw) => {
      const path = (raw as { path?: unknown } | null)?.path;
      return typeof path === "string" && path && !IN_GIT.test(path) ? [path] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

export function answerOf(
  method: string,
  params: Record<string, unknown>,
  answer: PermissionAnswer,
): Record<string, unknown> {
  switch (method) {
    case "item/permissions/requestApproval": {
      const allowed = answer.kind === "allow" || answer.kind === "allow-always";
      return {
        permissions: allowed ? (params.permissions ?? {}) : {},
        scope: answer.kind === "allow-always" ? "session" : "turn",
      };
    }
    case "item/tool/requestUserInput": {
      if (answer.kind !== "allow") return { answers: {} };
      const given = (answer.updatedInput?.answers ?? {}) as Record<string, unknown>;
      const questions = (Array.isArray(params.questions) ? params.questions : []) as {
        id?: unknown;
        question?: unknown;
      }[];
      const answers = questions.flatMap((q) => {
        if (typeof q?.id !== "string") return [];
        let text = Object.hasOwn(given, q.id) ? given[q.id] : undefined;
        if (
          text === undefined &&
          typeof q.question === "string" &&
          Object.hasOwn(given, q.question)
        ) {
          if (questions.some((other) => other !== q && other?.question === q.question)) {
            throw new Error("Questions with the same text need answers keyed by question ID");
          }
          text = given[q.question];
        }
        return typeof text === "string" && text ? [[q.id, { answers: [text] }]] : [];
      });
      return { answers: Object.fromEntries(answers) };
    }
  }
  switch (answer.kind) {
    case "allow":
      return { decision: "accept" };
    case "allow-always":
      return { decision: "acceptForSession" };
    case "deny":
      return { decision: "decline" };
    case "deny-stop":
      return { decision: "cancel" };
  }
}

function liveCodexResultThread(line: ChatLine): string | undefined {
  if (line.replay || line.dir !== "out") return;
  const message = line.message as { method?: string; params?: { threadId?: string } };
  if (message?.method === "turn/completed") return message.params?.threadId;
}

function phaseAfter(phase: ChatTabState["phase"], model: CodexModel): ChatTabState["phase"] {
  if (model.process === "exited" && (phase === "ready" || phase === "held")) return "ended";
  if (model.process === "running" && (phase === "ended" || phase === "held")) return "ready";
  return phase;
}

function startCodex(args: {
  workspaceId: string;
  tabId: string;
  cwd: string;
  resetLog?: boolean;
  connectionChanged?: boolean;
  profileId?: string;
}) {
  return ipcCallResult("chat", "codexStart", args).then(unwrapIpcResult);
}

export function isSupportedCodex(version: string | null | undefined): boolean {
  return !version || compareVersions(version, MIN_CODEX_VERSION) >= 0;
}

const controllers = new Map<string, CodexController>();

registerWorkspaceCleanup((workspaceId) => {
  const prefix = `${workspaceId}:`;
  for (const [key, controller] of controllers) {
    if (key.startsWith(prefix)) controller.dispose();
  }
});

export function codexController(target: CodexTabTarget, hooks?: CodexTabHooks): CodexController {
  const key = chatKey(target.workspaceId, target.tabId);
  let controller = controllers.get(key);
  if (!controller) {
    controller = new CodexController(target, hooks);
    controllers.set(key, controller);
  } else if (hooks) {
    controller.setHooks(hooks);
  }
  return controller;
}

export function existingCodexController(
  workspaceId: string,
  tabId: string,
): CodexController | undefined {
  return controllers.get(chatKey(workspaceId, tabId));
}

export function refreshCodexProfileConnection(profileId: string): void {
  for (const controller of controllers.values()) controller.profileConnectionChanged(profileId);
}

export function closeCodexTab(workspaceId: string, tabId: string): void {
  const controller = controllers.get(chatKey(workspaceId, tabId));
  if (controller) {
    void controller.close();
    return;
  }
  void ipcCallResult("chat", "close", { workspaceId, tabId }).catch(() => {});
}

const THREAD_LIST_LIMIT = 50;

export function threadsOf(data: unknown): Omit<ListedSession, "profileId">[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const thread = (raw ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const id = text(thread.id);
    const preview = text(thread.preview);
    const title = text(thread.name) ?? preview;
    if (!id || !title) return [];
    const branch = text((thread.gitInfo as { branch?: unknown } | null)?.branch);
    const updated = typeof thread.updatedAt === "number" ? thread.updatedAt : 0;
    const path = text(thread.path);
    return [
      {
        sessionId: id,
        title: title.split("\n")[0].slice(0, 200),
        ...(preview ? { firstPrompt: preview } : {}),
        ...(branch ? { gitBranch: branch } : {}),
        lastModified: updated * 1000,
        ...(path ? { path } : {}),
      },
    ];
  });
}
