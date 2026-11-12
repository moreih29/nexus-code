// One controller per Codex tab: starts `codex app-server` where the
// workspace runs (or re-attaches to the one the agent still runs for the
// tab), speaks its JSON-RPC, and feeds the log's lines to the Codex model.
//
// Like a Claude tab's, every line, the app's own included, reaches the
// model as the agent sends it back, so a live tab and one that replays the
// log after a window reload build the same view. The settings the user
// picks (model, effort, approvals) go with the next turn, as the server
// takes them: they hold for the thread from that turn on.

import { defaultProfileId, isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import { type RelayedMessage, type RelaySender, relayedText } from "../../../shared/chat/relay";
import { createLogger } from "../../../shared/log/renderer";
import { CHAT_MODES } from "../../../shared/sessions/chat-modes";
import type { ProfileMove } from "../../../shared/types/layout";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import {
  applyCodexLines,
  type CodexMode,
  type CodexModel,
  emptyCodexModel,
  idKey,
  nextThreadModel,
  shownUserText,
} from "./codex-model";
import type { PermissionAnswer } from "./controller";
import { addLineReceiver } from "./controller";
import { LiveLines } from "./live-lines";
import type { ChatLine, ImageBlock, PermissionRequest } from "./model";
import {
  forgetPlanWait,
  ingestCodexPush,
  planUsageKeyFor,
  registerPlanSource,
  wantPlanUsage,
} from "./plan-usage";
import { lastMessageId, sameProfile, withMove } from "./profile-moves";
import type { ListedSession } from "./sessions";
import {
  type ChatTabState,
  type CommandCard,
  chatKey,
  emptyTabState,
  type QueuedMessage,
  useChatStore,
} from "./store";
import { compareVersions } from "./versions";

const log = createLogger("codex");

/** Below this the tab does not run: the version its protocol was built and tried on. */
export const MIN_CODEX_VERSION = "0.166.0";

/** How long a request waits for its answer. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Longest a replay's lines, sent as events, may trail its answer. */
const REPLAY_CATCH_UP_MS = 3_000;
/** Most files an @-mention lists. */
const MAX_SUGGESTIONS = 50;

/** The Claude control requests the composer asks about that a Codex tab answers too. */
const SUPPORTED = new Set(["apply_flag_settings", "file_suggestions"]);

/** What answers each preset: the approval policy and the sandbox of a turn. */
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

/** What the server's own requests that no card answers are told. */
const UNSUPPORTED = { code: -32601, message: "NexusCode does not answer this request" };

interface ReplayResult {
  found: boolean;
  running: boolean;
  truncated: boolean;
  lastSeq: number;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexTabTarget {
  workspaceId: string;
  tabId: string;
  cwd: string;
  /** The thread the tab had, to go on with when its program is gone. */
  threadId?: string;
  /**
   * The thread a tab opened as a fork copies, until the copy has its own id
   * (/fork); `profileId` is the profile that keeps it, where it is not the
   * tab's (a thread gone on with in another profile).
   */
  fork?: { threadId: string; title?: string; profileId?: string };
  /** What the thread is told beside Codex's own instructions (the agent manager's). */
  developerInstructions?: string;
  /**
   * Whether Codex is to take the folder as trusted, so its own rules
   * (.codex/rules) apply, though the user's config says nothing of it (the
   * agent manager's).
   */
  trusted?: boolean;
  /** The agent profile its program runs with; absent = the default. */
  profileId?: string;
  /** Where the conversation went on in another profile. */
  moves?: readonly ProfileMove[];
}

export interface CodexTabHooks {
  /** The thread the tab now has, to keep with the tab. */
  onThread?: (threadId: string) => void;
  /** The first message of the conversation, for the tab's title. */
  onFirstMessage?: (text: string) => void;
  /** The name the thread was given, to take the first message's place. */
  onTitle?: (title: string) => void;
  /** The profile the tab runs with now, the user having switched it. */
  onProfile?: (profileId: string) => void;
  /** Where the conversation went on in another profile; none for a new one. */
  onMoves?: (moves: readonly ProfileMove[]) => void;
  /**
   * Who sent a message another agent sent through the nexus command, by its
   * client id; again with its turn once that is known.
   */
  onRelayed?: (record: RelayedMessage) => void;
}

/** The turn a message went into, as turn/start and turn/steer answer. */
function turnIdOf(result: Record<string, unknown>): string | undefined {
  const turn = result.turn;
  const id =
    turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : result.turnId;
  return typeof id === "string" ? id : undefined;
}

let counter = 0;

/** Ids no earlier run of the app has used, so a replayed log does not match them. */
function nextId(): string {
  counter += 1;
  return `app-${Date.now().toString(36)}-${counter}`;
}

export class CodexController {
  readonly key: string;
  /** The presets the composer's mode chip offers. */
  readonly modes = CHAT_MODES.codex;
  private target: CodexTabTarget;
  private hooks: CodexTabHooks;
  private readonly pending = new Map<string, Pending>();
  private buffered: ChatLine[] = [];
  /** New lines held while the log is sent again. */
  private readonly live = new LiveLines();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private opening: Promise<void> | null = null;
  /** The opening under way is a look: it starts no program. */
  private looking = false;
  /** A started program's handshake and thread, which a message waits for. */
  private ready: Promise<boolean> = Promise.resolve(false);
  /** The handshake of the program this controller started, until it settles. */
  private handshaking: Promise<boolean> | null = null;
  private disposed = false;
  private titled = false;
  /** What the user picked for the next turn. */
  private next: CodexPicks = {};
  private readonly removeReceiver: () => void;
  /** The tab as a source of its profile's plan usage, taken away as it closes. */
  private readonly leavePlanUsage: () => void;
  /** Whether the program is past its handshake, where it can be asked for its limits. */
  private limitsReadable = false;

  constructor(target: CodexTabTarget, hooks: CodexTabHooks = {}) {
    this.target = target;
    this.hooks = hooks;
    this.key = chatKey(target.workspaceId, target.tabId);
    this.removeReceiver = addLineReceiver(this.key, this);
    this.leavePlanUsage = registerPlanSource({
      agent: "codex",
      usageKey: () => this.usageKey(),
      ready: () =>
        this.limitsReadable && this.state.phase === "ready" && this.model.process === "running",
      busy: () => this.model.running,
      fetchUsage: () => this.request("account/rateLimits/read", {}),
    });
  }

  /** The profile whose plan usage the tab shows: its agent, host and profile. */
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

  /** Shows the tab's conversation: the agent's log, else a new or resumed program. */
  open(): Promise<void> {
    // A look under way starts nothing: the program starts once it is done.
    if (this.opening) return this.looking ? this.opening.then(() => this.open()) : this.opening;
    this.opening = this.doOpen(true).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /**
   * Shows the tab's conversation without starting its program, for the
   * agent list: the agent's log, else nothing: only its program reads a thread. The program starts with the
   * first message sent, or when the tab is shown.
   */
  look(): Promise<void> {
    if (this.opening) return this.opening;
    this.looking = true;
    this.opening = this.doOpen(false).finally(() => {
      this.opening = null;
      this.looking = false;
    });
    return this.opening;
  }

  private async doOpen(start: boolean): Promise<void> {
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
      if (replay.running) {
        this.ready = Promise.resolve(this.model.threadId !== undefined);
        // The limits may have moved while no window watched, or never been read.
        this.readRateLimits();
      }
      return;
    }
    if (!start) {
      this.update((prev) => ({ ...prev, phase: "ended" }));
      return;
    }
    await this.start({});
  }

  private async start(options: { resetLog?: boolean }): Promise<boolean> {
    const { workspaceId, tabId, cwd, profileId } = this.target;
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined }));
    let result: Awaited<ReturnType<typeof startCodex>>;
    try {
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
    if (!result.ok) {
      this.update((prev) => ({
        ...prev,
        phase: result.reason === "not-found" ? "not-found" : "failed",
        error: result.message,
      }));
      return false;
    }
    if (!isSupportedCodex(result.version)) {
      await ipcCallResult("chat", "stop", { workspaceId, tabId }).catch(() => {});
      this.update((prev) => ({
        ...prev,
        phase: "failed",
        version: result.version,
        error: "old-version",
      }));
      return false;
    }
    this.update((prev) => ({ ...prev, phase: "ready", version: result.version }));
    if (result.attached) {
      // A program this controller started a moment ago, whose start line has
      // not come yet: its handshake still decides.
      this.ready = this.handshaking ?? Promise.resolve(this.model.threadId !== undefined);
      this.readRateLimits();
      return true;
    }
    const handshake = this.handshake().finally(() => {
      if (this.handshaking === handshake) this.handshaking = null;
    });
    this.handshaking = handshake;
    this.ready = handshake;
    return true;
  }

  /** Introduces the app, then starts the tab's thread or goes on with the one it had. */
  private async handshake(): Promise<boolean> {
    try {
      await this.request("initialize", {
        clientInfo: { name: "nexus-code", title: "NexusCode", version: __APP_VERSION__ },
        capabilities: null,
      });
      await this.write({ method: "initialized" });
    } catch (err) {
      log.warn(`initialize failed: ${(err as Error).message}`);
      return false;
    }
    void this.request("account/read", {}).catch(() => {});
    void this.request("model/list", {}).catch(() => {});
    this.readRateLimits();
    const { cwd } = this.target;
    const settings = threadSettings(this.target);
    const threadId = this.model.threadId ?? this.target.threadId;
    const fork = this.target.fork;
    if (!threadId && fork) {
      const staged = await this.stage(fork);
      try {
        const forked = await this.request("thread/fork", {
          threadId: fork.threadId,
          cwd,
          ...settings,
        });
        const id = (forked.thread as { id?: unknown } | undefined)?.id;
        const copy = typeof id === "string" ? id : undefined;
        this.readGoal(copy);
        // The copy is called as the tab it came from was; one from another
        // profile keeps the name it had there, which Codex does not copy.
        this.titled = true;
        if (fork.title) {
          this.hooks.onTitle?.(fork.title);
          if (staged && copy) {
            void this.request("thread/name/set", { threadId: copy, name: fork.title }).catch(
              () => {},
            );
          }
        }
        return true;
      } catch (err) {
        log.warn(`thread ${fork.threadId} not forked: ${(err as Error).message}`);
      }
    }
    if (threadId) {
      try {
        // The log shows what came before already; a new log asks for it.
        await this.request("thread/resume", {
          threadId,
          cwd,
          excludeTurns: this.model.items.length > 0,
          ...settings,
        });
        this.readGoal(threadId);
        return true;
      } catch (err) {
        log.warn(`thread ${threadId} not resumed: ${(err as Error).message}`);
      }
    }
    try {
      await this.request("thread/start", threadStartParams(this.target, this.next));
      return true;
    } catch (err) {
      log.warn(`thread/start failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Puts a copy of the thread the tab's fork copies where this profile's
   * program finds it, when another profile keeps it: thread/fork finds a
   * thread only in the program's own folder. The copy stays, as do those of
   * the threads it was forked from: the fork reads its history from them
   * each time it resumes. Whether a copy was put there.
   */
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

  /**
   * Asks for the goal of a thread the tab goes on with: a thread's start
   * or resume does not tell it, and the server tells only its changes.
   */
  private readGoal(threadId: string | undefined): void {
    if (threadId) void this.request("thread/goal/get", { threadId }).catch(() => {});
  }

  /** Pauses the thread's goal, or goes on with it (the goal bar). */
  async setGoalStatus(status: "active" | "paused"): Promise<void> {
    const threadId = this.currentThread();
    if (threadId) await this.ask("thread/goal/set", { threadId, status, origin: "user" });
  }

  /** Clears the thread's goal (the goal bar). */
  async clearGoal(): Promise<void> {
    const threadId = this.currentThread();
    if (threadId) await this.ask("thread/goal/clear", { threadId });
  }

  /** Starts the program again, going on with the thread. */
  async restart(): Promise<void> {
    const { workspaceId, tabId } = this.target;
    if (this.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    await this.start({});
  }

  /**
   * The folder's threads that this profile's Codex keeps, newest first
   * (thread/list), but the tab's own: for /resume and a new tab's list.
   */
  async listThreads(): Promise<Omit<ListedSession, "profileId">[]> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    const own = this.currentThread();
    const result = await this.request("thread/list", {
      cwd: this.target.cwd,
      sortKey: "updated_at",
      limit: THREAD_LIST_LIMIT,
      ...(own ? { excludedThreadIds: [own] } : {}),
    });
    return threadsOf(result.data);
  }

  /**
   * Deletes one of the folder's threads for good (thread/delete): Codex
   * removes its file, so it leaves `codex resume` too and gives back the space.
   */
  async deleteThread(threadId: string): Promise<void> {
    if (threadId === this.currentThread()) throw new Error("the tab's own thread");
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    await this.request("thread/delete", { threadId });
  }

  /**
   * Goes on with another of the folder's threads in this tab (/resume):
   * the program starts again with it, and the tab shows its turns, under
   * the thread's name or first prompt.
   */
  async resumeThread(threadId: string, title: string): Promise<void> {
    if (this.model.running) throw new Error("a turn is running");
    const { workspaceId, tabId } = this.target;
    if (this.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    this.target = { ...this.target, threadId, moves: undefined };
    this.hooks.onThread?.(threadId);
    this.hooks.onMoves?.([]);
    this.hooks.onTitle?.(title);
    this.titled = true;
    // A command's card told of the thread the tab had.
    this.update((prev) => ({
      ...prev,
      history: null,
      queue: [],
      card: undefined,
      model: nextThreadModel(this.model),
    }));
    await this.start({ resetLog: true });
  }

  /**
   * Starts a new thread in this tab (/new): the program starts again
   * without one, and the tab takes its default name until the first message.
   */
  async newThread(): Promise<void> {
    if (this.model.running) throw new Error("a turn is running");
    const { workspaceId, tabId } = this.target;
    if (this.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    // The tab's model, effort and preset go on with the new thread, as the
    // CLI's /new keeps its session's; a pick not sent yet still wins.
    const picks = { ...picksOf(this.model), ...this.next };
    this.next = picks;
    this.target = { ...this.target, threadId: undefined, fork: undefined, moves: undefined };
    this.hooks.onMoves?.([]);
    this.hooks.onTitle?.("");
    this.titled = false;
    // The chips show the picks at once, not the defaults until the thread
    // starts; a command's card told of the thread the tab had.
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
    await this.start({ resetLog: true });
  }

  /**
   * Starts this tab over in a new thread with another profile: its program
   * stops, a turn under way with it, and the thread it had is left as it
   * was. The tab's model and effort are the old profile's, so the new one
   * starts with its own; the permission preset goes on.
   */
  async switchProfile(profileId: string): Promise<void> {
    if (sameProfile(profileId, this.target.profileId)) return;
    const { workspaceId, tabId } = this.target;
    if (this.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    const mode = this.next.mode ?? picksOf(this.model).mode;
    this.next = mode ? { mode } : {};
    this.target = {
      ...this.target,
      threadId: undefined,
      fork: undefined,
      profileId: isDefaultProfileId(profileId) ? undefined : profileId,
      moves: undefined,
    };
    this.hooks.onProfile?.(profileId);
    this.hooks.onTitle?.("");
    this.titled = false;
    // The account and its limits are the old profile's too.
    this.update((prev) => ({
      ...prev,
      history: null,
      queue: [],
      card: undefined,
      model: { ...emptyCodexModel(), lastSeq: this.model.lastSeq, permissionMode: mode },
    }));
    await this.start({ resetLog: true });
  }

  /**
   * Goes on with this tab's thread in another profile: its program stops, a
   * turn under way with it, and one of the new profile's forks the thread
   * from its file, its name too. The thread is left as it was, for the old
   * profile to go on with. The model and effort are the new profile's, the
   * permission preset goes on. A tab with no thread yet just switches.
   */
  async continueInProfile(profileId: string): Promise<void> {
    if (sameProfile(profileId, this.target.profileId)) return;
    const threadId = this.currentThread();
    if (!threadId) {
      await this.switchProfile(profileId);
      return;
    }
    const { workspaceId, tabId } = this.target;
    // Messages held for the turn's end would go to the program that stops.
    this.update((prev) => (prev.queue.length > 0 ? { ...prev, queue: [] } : prev));
    if (this.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    // Codex numbers a thread's items anew as it reads it; its turns keep their ids.
    const after = lastMessageId(this.model.items.filter((item) => item.kind === "assistant"));
    const moves = after
      ? withMove(this.target.moves, { profileId, after, at: Date.now() })
      : [...(this.target.moves ?? [])];
    const mode = this.next.mode ?? picksOf(this.model).mode;
    this.next = mode ? { mode } : {};
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
    this.hooks.onProfile?.(profileId);
    this.hooks.onMoves?.(moves);
    // The fork's answer brings the turns back; the account and its limits
    // are the old profile's.
    this.update((prev) => ({
      ...prev,
      history: null,
      card: undefined,
      model: { ...emptyCodexModel(), lastSeq: this.model.lastSeq, permissionMode: mode },
    }));
    await this.start({ resetLog: true });
  }

  /** Asks the program for a command (/mcp, /goal, /compact…), once it is running. */
  async ask(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    return this.request(method, params);
  }

  /** Shows what a command answered above the composer, until it is closed. */
  showCard(card: Omit<CommandCard, "id">): string {
    const id = nextId();
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

  /** The thread the tab goes on with, once it has one. */
  currentThread(): string | undefined {
    return this.model.threadId ?? this.target.threadId;
  }

  /** Reads again what the program is signed in with: after a sign-in in a terminal. */
  async refreshAccount(): Promise<void> {
    if (!(await this.ensureRunning())) return;
    await this.request("account/read", {}).catch(() => {});
    // Another sign-in: what the profile had heard, or had no limits, is past.
    forgetPlanWait(this.usageKey());
    this.readRateLimits();
  }

  /**
   * The program can be asked for the plan's usage limits now: the profile's
   * store asks, if it is time, through this tab or another of the profile's.
   * A ChatGPT sign-in has them, and the program reports them again as they
   * change. Without one it errs, quietly.
   */
  private readRateLimits(): void {
    this.limitsReadable = true;
    void wantPlanUsage(this.usageKey());
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
    while (this.model.lastSeq < replay.lastSeq && !this.disposed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      this.flushNow();
    }
  }

  /** The agent is back: replay what the tab missed, or find its program gone. */
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
      return;
    }
    // A new agent: what the tab showed stays, and the thread goes on when it starts again.
    this.update((prev) => ({
      ...prev,
      phase: "ended",
      model: { ...this.model, process: "exited", running: false, turn: null, permissions: [] },
    }));
    this.rejectPending("the program is gone");
  }

  held(): void {
    this.update((prev) => (prev.phase === "ready" ? { ...prev, phase: "held" } : prev));
  }

  /**
   * Starts the program when it is not running and waits for its thread,
   * with the turns a thread resumed after a restart brings: what the tab
   * shows then is all the conversation had before one more message.
   */
  async prepareSend(): Promise<void> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    if (!(await this.ready)) throw new Error("Codex has no thread to send to");
    this.flushNow();
  }

  /**
   * Sends a message now: during a turn it steers the turn, which reads it
   * next. One another agent sends through the nexus command (`from`) is led
   * by a line that tells Codex who sent it.
   */
  async send(text: string, images: ImageBlock[] = [], from?: RelaySender): Promise<void> {
    if (!(await this.ensureRunning())) return;
    if (!(await this.ready)) throw new Error("Codex has no thread to send to");
    // The thread's answer settles `ready` as it comes, a frame before its
    // line reaches the model: a message sent at once (a new task's, the
    // CLI's) would find no thread yet.
    this.flushNow();
    const threadId = this.model.threadId;
    if (!threadId) throw new Error("Codex has no thread to send to");
    const said = from && text ? relayedText(from, text) : text;
    const input = [
      ...(said ? [{ type: "text", text: said, text_elements: [] }] : []),
      ...images.map((image) => ({
        type: "image",
        url: `data:${image.mediaType};base64,${image.data}`,
      })),
    ];
    // The tab is called by the conversation's first message, not by the
    // first one sent since the app started: a thread resumed after a restart
    // (no log to replay) shows the messages it had.
    if (!this.titled && text.trim()) {
      this.titled = true;
      if (!this.model.items.some((item) => item.kind === "user")) {
        this.hooks.onFirstMessage?.(shownUserText(text).trim());
      }
    }
    const clientUserMessageId = nextId();
    // Kept before the message is written, so it never shows as the user's;
    // with its turn too, which a resumed thread keeps (not the message's id).
    const record = from ? { id: clientUserMessageId, from, at: Date.now() } : undefined;
    if (record) this.hooks.onRelayed?.(record);
    const told = (result: Record<string, unknown>, fallback?: string) => {
      const turn = turnIdOf(result) ?? fallback;
      if (record && turn) this.hooks.onRelayed?.({ ...record, turnId: turn });
    };
    const { running, turnId } = this.model;
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
        log.info(`steer not taken: ${(err as Error).message}`);
        // A new turn runs: the message waits for it to end.
        if (this.model.running) {
          this.enqueue(text, images, from);
          return;
        }
        // The turn ended meanwhile: the message starts the next one.
      }
    }
    const { model, effort, mode } = this.next;
    this.next = {};
    // Its answer, or its error as a notice, comes in the log.
    void this.request("turn/start", {
      threadId,
      clientUserMessageId,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? MODE_SETTINGS[mode] : {}),
    })
      .then((result) => told(result))
      .catch(() => {});
  }

  /** Puts `text` in the tab's message box, after what is typed there, to be sent from it. */
  putDraft(text: string): void {
    this.update((prev) => ({ ...prev, draft: { text, images: [], nonce: Date.now() } }));
  }

  /** The composer took the message the app put back. */
  clearDraft(): void {
    this.update((prev) => (prev.draft ? { ...prev, draft: undefined } : prev));
  }

  /** Holds a message until the turn ends (⌘⇧↩). */
  enqueue(text: string, images: ImageBlock[] = [], from?: RelaySender): void {
    const item: QueuedMessage = { id: nextId(), text, images, ...(from ? { from } : {}) };
    this.update((prev) => ({ ...prev, queue: [...prev.queue, item] }));
    if (!this.model.running) this.sendNextQueued();
  }

  removeQueued(id: string): QueuedMessage | undefined {
    const item = this.state.queue.find((q) => q.id === id);
    this.update((prev) => ({ ...prev, queue: prev.queue.filter((q) => q.id !== id) }));
    return item;
  }

  private sendNextQueued(): void {
    const [next] = this.state.queue;
    if (!next) return;
    this.update((prev) => ({ ...prev, queue: prev.queue.slice(1) }));
    void this.send(next.text, next.images, next.from).catch((err: Error) => log.warn(err.message));
  }

  async interrupt(): Promise<unknown> {
    const { threadId, turnId } = this.model;
    if (!threadId || !turnId) return undefined;
    return this.request("turn/interrupt", { threadId, turnId });
  }

  /** Picks a preset for the next turn on, shown at once. */
  async setPermissionMode(mode: string): Promise<unknown> {
    if (!(mode in MODE_SETTINGS)) throw new Error(`unknown mode ${mode}`);
    this.next = { ...this.next, mode: mode as CodexMode };
    this.patchModel({ permissionMode: mode });
    return undefined;
  }

  async setModel(model: string): Promise<unknown> {
    this.next = { ...this.next, model };
    this.patchModel({ model });
    return undefined;
  }

  async setEffort(level: string): Promise<unknown> {
    this.next = { ...this.next, effort: level };
    this.patchModel({ effort: level });
    return undefined;
  }

  /**
   * The model and reasoning effort a new conversation starts with, as
   * Codex's config has them for the tab's folder (config/read).
   */
  async readDefaults(): Promise<{ model?: string; effort?: string }> {
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    const result = await this.request("config/read", { cwd: this.target.cwd });
    const config = (result.config ?? {}) as { model?: unknown; model_reasoning_effort?: unknown };
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { model: text(config.model), effort: text(config.model_reasoning_effort) };
  }

  /**
   * Saves new defaults in the profile's config.toml (config/batchWrite),
   * where Codex's /model would. Conversations already open keep theirs,
   * but this tab takes them, as the CLI's session does.
   */
  async saveDefaults(defaults: { model?: string; effort?: string }): Promise<void> {
    const edits = [
      ...(defaults.model ? [{ keyPath: "model", value: defaults.model }] : []),
      ...(defaults.effort ? [{ keyPath: "model_reasoning_effort", value: defaults.effort }] : []),
    ].map((edit) => ({ ...edit, mergeStrategy: "replace" }));
    if (edits.length === 0) return;
    if (!(await this.ensureRunning())) throw new Error("Codex is not running");
    await this.request("config/batchWrite", { edits });
    if (defaults.model) await this.setModel(defaults.model);
    if (defaults.effort) await this.setEffort(defaults.effort);
  }

  private patchModel(patch: Partial<CodexModel>): void {
    this.update((prev) => ({ ...prev, model: { ...prev.model, ...patch } }));
  }

  supports(subtype: string): boolean {
    return SUPPORTED.has(subtype);
  }

  /** Files of the folder an @-mention may name, as the server's fuzzy search finds them. */
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

  /** Writes a file attached to a message where the program can read it; its path there. */
  async attach(name: string, data: string): Promise<string> {
    const { workspaceId, tabId } = this.target;
    const result = unwrapIpcResult(
      await ipcCallResult("chat", "attach", { workspaceId, tabId, name, data }),
    );
    return result.path;
  }

  /** Answers an approval or a question the server asked. */
  async answerPermission(request: PermissionRequest, answer: PermissionAnswer): Promise<void> {
    const asked = this.model.requests[request.requestId];
    if (!asked) return;
    const id = JSON.parse(request.requestId) as string | number;
    const result = answerOf(asked.method, asked.params, answer);
    await this.write({ id, result });
    // What the user said with a decline goes to the turn, which goes on.
    const message = answer.kind === "deny" ? answer.message : undefined;
    if (message) await this.send(message).catch(() => {});
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = nextId();
    const key = idKey(id) as string;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });
    this.write({ id, method, params }).catch((err: Error) => {
      const entry = this.pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(key);
      entry.reject(err);
    });
    return promise;
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const { workspaceId, tabId } = this.target;
    unwrapIpcResult(await ipcCallResult("chat", "send", { workspaceId, tabId, message }));
  }

  /** Starts the program again when it is not running, for a message to go to. */
  private async ensureRunning(): Promise<boolean> {
    if (this.opening) await this.opening;
    // The program's start line may wait for the next frame: a message sent as
    // the tab opens (a new task's, the CLI's) would start it again.
    this.flushNow();
    const { phase } = this.state;
    if (phase === "ready" && this.model.process === "running") return true;
    if (phase === "held" || phase === "not-found") return false;
    return this.start({});
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
    const key = idKey(message.id);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (key && !method) {
      const entry = this.pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(key);
      const error = message.error as { message?: unknown } | undefined;
      if (error) entry.reject(new Error(String(error.message ?? "error")));
      else entry.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }
    if (key && method && !CARD_REQUESTS.has(method)) {
      // Requests no card answers are refused, so the turn does not wait on them.
      const reply =
        method === "mcpServer/elicitation/request"
          ? { id: message.id, result: { action: "decline", content: null, _meta: null } }
          : { id: message.id, error: UNSUPPORTED };
      void this.write(reply).catch(() => {});
      return;
    }
    if (method === "account/login/completed") void this.refreshAccount();
    // After a turn: the profile's limits as they are now, for all its tabs.
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
    const model = applyCodexLines(before, lines);
    if (model === before) return;
    this.update((prev) => ({ ...prev, model, phase: phaseAfter(prev.phase, model) }));
    if (model.threadId && model.threadId !== this.target.threadId) {
      this.target = { ...this.target, threadId: model.threadId, fork: undefined };
      this.hooks.onThread?.(model.threadId);
    }
    // The thread's name, when it gets one or another (/rename), is the tab's.
    if (model.threadName && model.threadName !== before.threadName) {
      this.titled = true;
      this.hooks.onTitle?.(model.threadName);
    }
    if (before.running && !model.running) this.sendNextQueued();
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
    this.removeReceiver();
    this.leavePlanUsage();
    useChatStore.getState().remove(this.key);
    controllers.delete(this.key);
  }
}

/** The sandbox of a thread a preset starts, as thread/start names it. */
const SANDBOX_MODES: Record<CodexMode, string> = {
  readOnly: "read-only",
  auto: "workspace-write",
  fullAccess: "danger-full-access",
};

/** The server's requests a permission card answers. */
const CARD_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

/**
 * What a tab's thread starts or goes on with beside its folder: the
 * instructions it is given, and the folder's trust, for this thread only.
 * Codex reads a folder's own rules only when it is trusted, and said here
 * the trust is written to no config of the user's.
 */
export function threadSettings({
  cwd,
  developerInstructions,
  trusted,
}: CodexTabTarget): Record<string, unknown> {
  return {
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(trusted ? { config: { projects: { [cwd]: { trust_level: "trusted" } } } } : {}),
  };
}

/** The model, effort and preset a tab picked, for its next turn or thread. */
export interface CodexPicks {
  model?: string;
  effort?: string;
  mode?: CodexMode;
}

/** What a thread runs with, as picks: for a new thread to start as it did. */
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

/**
 * thread/start's params: the tab's settings, then its picks; the effort
 * as a config override, as thread/start takes it no other way.
 */
export function threadStartParams(
  target: CodexTabTarget,
  picks: CodexPicks,
): Record<string, unknown> {
  const settings = threadSettings(target);
  const config = {
    ...(settings.config as Record<string, unknown> | undefined),
    ...(picks.effort ? { model_reasoning_effort: picks.effort } : {}),
  };
  return {
    cwd: target.cwd,
    ...settings,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(picks.model ? { model: picks.model } : {}),
    ...(picks.mode
      ? {
          approvalPolicy: MODE_SETTINGS[picks.mode].approvalPolicy,
          sandbox: SANDBOX_MODES[picks.mode],
        }
      : {}),
  };
}

/** A path in a `.git` folder, by either separator: git's files, not the project's. */
const IN_GIT = /(^|[\\/])\.git([\\/]|$)/;

/**
 * The paths an @-mention may name among the server's fuzzy search results.
 * The search leaves out what .gitignore does, but not git's own folder.
 */
export function suggestedPaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .flatMap((raw) => {
      const path = (raw as { path?: unknown } | null)?.path;
      return typeof path === "string" && path && !IN_GIT.test(path) ? [path] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

/** The answer to a request of the server's, from what the user picked on its card. */
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
      const answers: Record<string, { answers: string[] }> = {};
      for (const raw of Array.isArray(params.questions) ? params.questions : []) {
        const q = raw as { id?: unknown; question?: unknown };
        const text = typeof q.question === "string" ? given[q.question] : undefined;
        if (typeof q.id === "string" && typeof text === "string" && text) {
          answers[q.id] = { answers: [text] };
        }
      }
      return { answers };
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
  profileId?: string;
}) {
  return ipcCallResult("chat", "codexStart", args).then(unwrapIpcResult);
}

export function isSupportedCodex(version: string | null | undefined): boolean {
  return !version || compareVersions(version, MIN_CODEX_VERSION) >= 0;
}

// ---------------------------------------------------------------------------
// Registry: one controller per tab.
// ---------------------------------------------------------------------------

const controllers = new Map<string, CodexController>();

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

/** The controller of a Codex tab whose view was shown since the app started. */
export function existingCodexController(
  workspaceId: string,
  tabId: string,
): CodexController | undefined {
  return controllers.get(chatKey(workspaceId, tabId));
}

/** Ends a closed tab's program, whether or not its view was ever shown. */
export function closeCodexTab(workspaceId: string, tabId: string): void {
  const controller = controllers.get(chatKey(workspaceId, tabId));
  if (controller) {
    void controller.close();
    return;
  }
  void ipcCallResult("chat", "close", { workspaceId, tabId }).catch(() => {});
}

/** How many of the folder's threads /resume lists. */
const THREAD_LIST_LIMIT = 50;

/** thread/list's threads as a tab's list shows them: the title it was given, else its first prompt. */
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
