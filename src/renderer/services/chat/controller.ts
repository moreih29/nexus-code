// One controller per Claude tab: starts or re-attaches to the tab's program,
// feeds its lines to the chat model, and writes the user's messages,
// control requests and permission answers to it.
//
// Every line, the app's own included, reaches the model as the agent sends
// it back (chat.line), so a live tab and one that replays the log after a
// window reload build the same view.

import { defaultProfileId, isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { backgroundIdOf } from "./app-commands";
import {
  type HistoryCut,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  uuidBefore,
} from "./history";
import { LiveLines } from "./live-lines";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ImageBlock,
  type PermissionRequest,
  type UserItem,
} from "./model";
import { effortToApply } from "./settings-defaults";
import {
  type ChatTabState,
  type CommandCard,
  chatKey,
  emptyTabState,
  type QueuedMessage,
  useChatStore,
} from "./store";
import { isSupportedClaude, supportsControl } from "./versions";

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

/** Least time between two asks for the plan's usage the line under the composer makes. */
const USAGE_REFRESH_MS = 60_000;

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
  /** The tab runs with another profile now: it took up a session that one keeps. */
  onProfile?: (profileId: string) => void;
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
  /** The flag settings the tab's commands set (/add-dir, /sandbox). */
  private flags: Record<string, unknown> = {};
  /** A started program's initialize, and the flags given again after it. */
  private initializing: Promise<void> = Promise.resolve();
  private buffered: ChatLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** New lines held while the log is sent again. */
  private readonly live = new LiveLines();
  private readonly pending = new Map<string, PendingControl>();
  private opening: Promise<void> | null = null;
  private disposed = false;
  private titled = false;
  /** When the line under the composer last asked for the plan's usage. */
  private usageAskedAt = Number.NEGATIVE_INFINITY;
  /** The name the program last said its session has. */
  private sessionName: string | undefined;
  private sessionId: string | undefined;

  /** The profile the tab's program runs with, for a tab made from it to keep. */
  get profileId(): string {
    return this.target.profileId ?? defaultProfileId("claude");
  }

  constructor(target: ChatTabTarget, hooks: ChatTabHooks = {}) {
    this.target = target;
    this.hooks = hooks;
    this.key = chatKey(target.workspaceId, target.tabId);
    this.sessionId = target.sessionId;
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
    this.opening = this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<void> {
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
      return;
    }
    // The agent has no log: a new tab, or one whose agent restarted.
    if (this.target.fork) {
      await this.loadTranscript(this.target.fork.sessionId, forkCut(this.target.fork));
    } else if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
    }
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
      await this.loadTranscript(this.target.fork.sessionId, forkCut(this.target.fork));
    } else if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
    }
  }

  private async loadTranscript(sessionId: string, cut?: HistoryCut): Promise<void> {
    try {
      const result = unwrapIpcResult(
        await ipcCallResult("chat", "transcript", {
          workspaceId: this.target.workspaceId,
          sessionId,
          ...profileArg(this.target.profileId),
        }),
      );
      if (!result.found) return;
      const history = historyModel(result.lines, cut);
      const first = history.items.find((item) => item.kind === "user" && item.text.trim());
      // A session that was named, by the user or by Claude, is called by its name.
      const title = cut ? undefined : sessionTitleOf(result.lines);
      if (!this.titled && title) {
        this.titled = true;
        this.hooks.onTitle?.(title);
      } else if (!this.titled && first?.kind === "user") {
        this.titled = true;
        this.hooks.onFirstMessage?.(first.text.trim());
      }
      this.update((prev) => ({ ...prev, history: history.items.length > 0 ? history : null }));
    } catch (err) {
      log.warn(`transcript of ${sessionId} not read: ${(err as Error).message}`);
    }
  }

  private async start(resume: StartArgs): Promise<boolean> {
    const { workspaceId, tabId, cwd } = this.target;
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined }));
    let result: Awaited<ReturnType<typeof startChat>>;
    try {
      result = await startChat({
        workspaceId,
        tabId,
        cwd,
        ...resume,
        ...profileArg(this.target.profileId),
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
    if (!isSupportedClaude(result.version)) {
      this.update((prev) => ({
        ...prev,
        phase: "failed",
        version: result.version,
        error: "old-version",
      }));
      return false;
    }
    this.update((prev) => ({ ...prev, phase: "ready", version: result.version }));
    if (!result.attached) {
      // Subagents' text comes as messages under their Agent call, for the agent strip.
      this.initializing = this.request("initialize", { hooks: null, forwardSubagentText: true })
        .then(() => {
          // What /add-dir and /sandbox set holds for the tab, not one program.
          if (Object.keys(this.flags).length > 0) {
            return this.request("apply_flag_settings", { settings: this.flags });
          }
        })
        .then(() => this.followSettings())
        .then(
          () => {},
          (err: Error) => {
            log.warn(`initialize failed: ${err.message}`);
          },
        );
    }
    return true;
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
    return at ? { sessionId, at } : null;
  }

  /** What rewinding the files to before a message would change. */
  async previewRewind(uuid: string): Promise<RewindPreview> {
    if (!(await this.ensureRunning())) throw new Error("the program is not running");
    return rewindOf(await this.request("rewind_files", { user_message_id: uuid, dry_run: true }));
  }

  /**
   * Goes back to before one of the user's messages, in this tab: the files
   * first when asked, then the conversation, by a program that copies the
   * session up to the message before it. The message goes back in the composer.
   */
  async rewind(item: UserItem, { files }: { files: boolean }): Promise<void> {
    const uuid = item.uuid;
    if (!uuid) throw new Error("the message has no uuid yet");
    if (this.state.model.running) throw new Error("a turn is running");
    if (files) {
      if (!(await this.ensureRunning())) throw new Error("the program is not running");
      const result = rewindOf(await this.request("rewind_files", { user_message_id: uuid }));
      if (!result.canRewind) throw new Error(result.error ?? "the files were not rewound");
    }
    const all = joinHistory(this.state.history, this.state.model);
    const fork = this.forkPoint(uuid, { before: true }) ?? undefined;
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    this.sessionId = undefined;
    this.target = { ...this.target, sessionId: undefined, fork };
    this.hooks.onTarget?.(fork ? { fork } : {});
    const kept = modelBefore(all, uuid);
    this.update((prev) => ({
      ...prev,
      history: kept.items.length > 0 ? kept : null,
      // The old program's last lines stay out of sight until the log starts over.
      model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
      draft: { text: item.text, images: item.images, nonce: Date.now() },
    }));
    if (await this.start({ ...this.startArgs(), resetLog: true })) await this.rebuild();
  }

  /**
   * Goes on with another session of the folder in this tab, which has no
   * conversation yet: its program starts over on that session.
   */
  async resumeSession(sessionId: string, profileId?: string): Promise<void> {
    if (this.state.model.running) throw new Error("a turn is running");
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    this.sessionId = sessionId;
    this.target = { ...this.target, sessionId, fork: undefined };
    // The session goes on in the profile that keeps it.
    if (profileId && profileId !== this.profileId) {
      this.target = {
        ...this.target,
        profileId: isDefaultProfileId(profileId) ? undefined : profileId,
      };
      this.hooks.onProfile?.(profileId);
    }
    this.hooks.onTarget?.({ sessionId });
    this.titled = false;
    this.update((prev) => ({
      ...prev,
      history: null,
      model: { ...emptyModel(), lastSeq: prev.model.lastSeq },
    }));
    await this.loadTranscript(sessionId);
    if (await this.start({ resume: sessionId, resetLog: true })) await this.rebuild();
  }

  /**
   * Names the tab's session, as /rename does: its program is started for it
   * when it is not running. False when the session cannot be named: it has
   * no conversation yet, or its version cannot.
   */
  async renameSession(title: string): Promise<boolean> {
    const sessionId = this.state.model.sessionId ?? this.sessionId;
    if (!sessionId || !title.trim()) return false;
    // The tab took the name from the session: it has it already.
    if (title.trim() === this.sessionName) return true;
    if (!(await this.ensureRunning()) || !this.supports("rename_session")) return false;
    await this.request("rename_session", {
      title: title.trim(),
      // The user's own rename, for the session it was made on.
      source: "host",
      session_id: sessionId,
    });
    return true;
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
    let replay: ReplayResult;
    try {
      replay = await this.replay(this.state.model.lastSeq);
    } catch {
      return;
    }
    if (replay.found) {
      this.update((prev) => ({ ...prev, phase: replay.running ? "ready" : "ended" }));
      return;
    }
    // A new agent: what the tab showed becomes its history.
    this.update((prev) => ({
      ...prev,
      phase: "ended",
      history: joinHistory(prev.history, prev.model),
      model: emptyModel(),
    }));
    this.rejectPending("the program is gone");
  }

  held(): void {
    this.update((prev) => (prev.phase === "ready" ? { ...prev, phase: "held" } : prev));
  }

  /** Sends a message now: during a turn, Claude reads it after the current tool. */
  send(text: string, images: ImageBlock[] = []): Promise<void> {
    return this.sendMessage(text, images, false);
  }

  /**
   * Sends a message Claude reads at once (⌘↩): during a turn, what Claude
   * runs that can go on in the background goes there, and the turn stops
   * for the message when nothing can.
   */
  sendNow(text: string, images: ImageBlock[] = []): Promise<void> {
    return this.sendMessage(text, images, true);
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

  private async sendMessage(text: string, images: ImageBlock[], now: boolean): Promise<void> {
    if (!(await this.ensureRunning())) return;
    const first = !this.titled && text.trim() ? text.trim() : undefined;
    if (first) {
      this.titled = true;
      this.hooks.onFirstMessage?.(first);
    }
    await this.write(userMessageOf(text, images, now));
    if (first) void this.nameSession(first);
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

  /** Holds a message until the turn ends (⌘⇧↩). */
  enqueue(text: string, images: ImageBlock[] = []): void {
    const item: QueuedMessage = { id: nextRequestId(), text, images };
    this.update((prev) => ({ ...prev, queue: [...prev.queue, item] }));
    if (!this.state.model.running) this.sendNextQueued();
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
    void this.send(next.text, next.images);
  }

  interrupt(): Promise<unknown> {
    return this.request("interrupt", {});
  }

  setPermissionMode(mode: string): Promise<unknown> {
    return this.request("set_permission_mode", { mode });
  }

  setModel(model: string): Promise<unknown> {
    return this.request("set_model", { model });
  }

  setEffort(level: string): Promise<unknown> {
    // Holds for the tab: a program started again for it takes it too.
    this.flags = { ...this.flags, effortLevel: level };
    return this.request("apply_flag_settings", { settings: { effortLevel: level } });
  }

  /** Stops one of the CLI's tasks: a subagent, a command in the background. */
  stopTask(taskId: string): Promise<unknown> {
    return this.request("stop_task", { task_id: taskId });
  }

  /**
   * Asks for what the side panel shows that only a request tells: the
   * context, the plan's usage, the MCP servers. Only while the program
   * runs; the answers land in the model.
   */
  refreshPanel(parts: readonly PanelPart[]): void {
    const { phase, model } = this.state;
    if (phase !== "ready" || model.process !== "running") return;
    for (const part of parts) {
      const subtype = PANEL_REQUESTS[part];
      if (this.supports(subtype)) this.request(subtype, {}).catch(() => {});
    }
  }

  /**
   * Asks again for what the line under the composer shows: the context each
   * time, the plan's usage (a request to Anthropic's servers) at most once a
   * minute.
   */
  refreshUsageLine(now: number = Date.now()): void {
    const { phase, model } = this.state;
    if (phase !== "ready" || model.process !== "running") return;
    const parts: PanelPart[] = ["context"];
    if (now - this.usageAskedAt >= USAGE_REFRESH_MS) {
      this.usageAskedAt = now;
      parts.push("usage");
    }
    this.refreshPanel(parts);
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
      const body = (await this.request("mcp_authenticate", { serverName, redirectUri })) as
        | { authUrl?: unknown; callbackExpected?: unknown; callbackPort?: unknown }
        | undefined;
      const authUrl = typeof body?.authUrl === "string" ? body.authUrl : undefined;
      if (!authUrl) {
        // Signed in already: nothing to open.
        void ipcCallResult("chat", "oauthCancel", { id });
        await this.request("mcp_reconnect", { serverName });
        return;
      }
      if (body?.callbackExpected === false || typeof body?.callbackPort === "number") {
        // Nothing comes back here: a claude.ai connector is connected on
        // claude.ai, and a version that keeps its own callback takes it on
        // the host it runs on.
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
   */
  async readConfig(): Promise<{
    effective: Record<string, unknown>;
    global: Record<string, unknown>;
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
    return {
      effective:
        typeof effective === "object" && effective !== null
          ? (effective as Record<string, unknown>)
          : {},
      global,
    };
  }

  /**
   * Sends Claude Code's own commands as messages (/config key=value),
   * which it runs without the model: unlike a message, they do not name
   * the conversation. Each goes once the one before is done, so that it
   * is not taken for a message waiting on a turn.
   */
  async sendCommands(texts: readonly string[]): Promise<void> {
    for (const [index, text] of texts.entries()) {
      if (!(await this.ensureRunning())) throw new Error("Claude is not running");
      const message = userMessageOf(text, []);
      await this.write(message);
      if (index < texts.length - 1) await this.commandDone(message.uuid as string);
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
    return this.request("remote_control", { enabled });
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
  ): Promise<Record<string, unknown>> {
    if (!this.supports(subtype)) {
      return Promise.reject(new Error(`${subtype} needs a newer Claude Code`));
    }
    const id = nextRequestId();
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
    const { workspaceId, tabId } = this.target;
    unwrapIpcResult(await ipcCallResult("chat", "send", { workspaceId, tabId, message }));
  }

  /** Starts the program again when it is not running, for a message to go to. */
  private async ensureRunning(): Promise<boolean> {
    if (this.opening) await this.opening;
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
    } else if (message.type === "system" && message.subtype === "session_title_changed") {
      // Said when the name changes, and as the program starts on a session
      // that has one; the CLI has trimmed it and made it unique.
      const title = typeof message.title === "string" ? message.title.trim() : "";
      if (title && title !== this.sessionName) {
        this.sessionName = title;
        this.titled = true;
        this.hooks.onRename?.(title);
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
    if (model.sessionId && model.sessionId !== this.sessionId) {
      // The copy a fork made has its own id now: the tab goes on with it.
      this.sessionId = model.sessionId;
      this.target = { ...this.target, fork: undefined };
      this.hooks.onSession?.(model.sessionId);
    }
    // What the tab showed before a /clear is another session's.
    if ((model.clears ?? 0) !== (before.clears ?? 0)) {
      this.update((prev) => (prev.history ? { ...prev, history: null } : prev));
    }
    if (before.running && !model.running) this.sendNextQueued();
    if (model.process === "exited" && before.process !== "exited") {
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
let listening = false;

/** What else the agent's chat lines go to: another program's tab (Codex). */
export interface LineReceiver {
  readonly key: string;
  receive(line: ChatLine): void;
  held(): void;
  resync(): Promise<void>;
}

const receivers = new Map<string, LineReceiver>();

/** Sends a tab's lines and its agent's comings and goings to a receiver; undone by the result. */
export function addLineReceiver(key: string, receiver: LineReceiver): () => void {
  ensureListeners();
  receivers.set(key, receiver);
  return () => {
    if (receivers.get(key) === receiver) receivers.delete(key);
  };
}

function receiversOf(workspaceId: string): LineReceiver[] {
  return [...controllers.values(), ...receivers.values()].filter((r) =>
    r.key.startsWith(`${workspaceId}:`),
  );
}

function ensureListeners(): void {
  if (listening) return;
  listening = true;
  ipcListen("chat", "line", (line) => {
    const key = chatKey(line.workspaceId, line.tabId);
    (controllers.get(key) ?? receivers.get(key))?.receive(line as ChatLine);
  });
  ipcListen("chat", "held", ({ workspaceId }) => {
    for (const receiver of receiversOf(workspaceId)) receiver.held();
  });
  ipcListen("chat", "resync", ({ workspaceId }) => {
    for (const receiver of receiversOf(workspaceId)) void receiver.resync();
  });
}

/** The tab's controller, made on first use. */
const pruned = new Set<string>();

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

/** The controller of a Claude tab that was shown, if any: its program and requests. */
export function existingChatController(
  workspaceId: string,
  tabId: string,
): ChatController | undefined {
  return controllers.get(chatKey(workspaceId, tabId));
}

export function chatController(target: ChatTabTarget, hooks?: ChatTabHooks): ChatController {
  ensureListeners();
  const key = chatKey(target.workspaceId, target.tabId);
  let controller = controllers.get(key);
  if (!controller) {
    controller = new ChatController(target, hooks);
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
    uuid: crypto.randomUUID(),
    ...(now ? { priority: "now", origin: { kind: "human" } } : {}),
  };
}
