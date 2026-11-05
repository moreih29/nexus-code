// One controller per Claude tab: starts or re-attaches to the tab's program,
// feeds its lines to the chat model, and writes the user's messages,
// control requests and permission answers to it.
//
// Every line, the app's own included, reaches the model as the agent sends
// it back (chat.line), so a live tab and one that replays the log after a
// window reload build the same view.

import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import {
  type HistoryCut,
  historyModel,
  joinHistory,
  modelBefore,
  modelUuids,
  sessionTitleOf,
  uuidBefore,
} from "./history";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ImageBlock,
  type PermissionRequest,
  type UserItem,
} from "./model";
import {
  type ChatTabState,
  chatKey,
  emptyTabState,
  type QueuedMessage,
  useChatStore,
} from "./store";
import { isSupportedClaude, supportsControl } from "./versions";

const log = createLogger("chat");

/** How long a control request waits for its answer. */
const CONTROL_TIMEOUT_MS = 15_000;

/** Longest a replay's lines, sent as events, may trail its answer. */
const REPLAY_CATCH_UP_MS = 3_000;

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
}

export interface ChatTabHooks {
  /** The session id the tab now has, to keep with the tab. */
  onSession?: (sessionId: string) => void;
  /** A rewind moved the tab to a new start: a fork, or no session at all. */
  onTarget?: (target: { sessionId?: string; fork?: ForkPoint }) => void;
  /** The first message of the conversation, for the tab's title. */
  onFirstMessage?: (text: string) => void;
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
  | { kind: "allow-always" }
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
  private buffered: ChatLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingControl>();
  private opening: Promise<void> | null = null;
  private disposed = false;
  private titled = false;
  private sessionId: string | undefined;

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
    const { workspaceId, tabId } = this.target;
    this.flushNow();
    this.update((prev) => ({ ...prev, phase: "starting", error: undefined, model: emptyModel() }));
    let replay: ReplayResult;
    try {
      replay = unwrapIpcResult(await ipcCallResult("chat", "replay", { workspaceId, tabId }));
    } catch (err) {
      this.update((prev) => ({ ...prev, phase: "failed", error: (err as Error).message }));
      return;
    }
    await this.catchUp(replay);
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
        }),
      );
      if (!result.found) return;
      const history = historyModel(result.lines, cut);
      const first = history.items.find((item) => item.kind === "user" && item.text.trim());
      // A session that was named is called by its name.
      const title = cut ? undefined : sessionTitleOf(result.lines);
      if (!this.titled && (title || first?.kind === "user")) {
        this.titled = true;
        this.hooks.onFirstMessage?.(title ?? (first?.kind === "user" ? first.text.trim() : ""));
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
      result = await startChat({ workspaceId, tabId, cwd, ...resume });
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
      this.request("initialize", { hooks: null, forwardSubagentText: true }).catch((err: Error) => {
        log.warn(`initialize failed: ${err.message}`);
      });
    }
    return true;
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
  async resumeSession(sessionId: string): Promise<void> {
    if (this.state.model.running) throw new Error("a turn is running");
    const { workspaceId, tabId } = this.target;
    if (this.state.model.process === "running") {
      await ipcCallResult("chat", "stop", { workspaceId, tabId });
    }
    this.flushNow();
    this.sessionId = sessionId;
    this.target = { ...this.target, sessionId, fork: undefined };
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
    const { workspaceId, tabId } = this.target;
    this.flushNow();
    this.update((prev) => ({ ...prev, model: emptyModel() }));
    try {
      await this.catchUp(
        unwrapIpcResult(await ipcCallResult("chat", "replay", { workspaceId, tabId })),
      );
    } catch (err) {
      log.warn(`replay after a rewind failed: ${(err as Error).message}`);
    }
    this.flushNow();
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
    const { workspaceId, tabId } = this.target;
    this.flushNow();
    let replay: ReplayResult;
    try {
      replay = unwrapIpcResult(
        await ipcCallResult("chat", "replay", {
          workspaceId,
          tabId,
          afterSeq: this.state.model.lastSeq,
        }),
      );
    } catch {
      return;
    }
    await this.catchUp(replay);
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
  async send(text: string, images: ImageBlock[] = []): Promise<void> {
    if (!(await this.ensureRunning())) return;
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
    if (!this.titled && text.trim()) {
      this.titled = true;
      this.hooks.onFirstMessage?.(text.trim());
    }
    await this.write({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  /** The composer took the message a rewind or fork put back. */
  clearDraft(): void {
    this.update((prev) => (prev.draft ? { ...prev, draft: undefined } : prev));
  }

  /** Holds a message until the turn ends (⌘↩). */
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

  async mcpReconnect(serverName: string): Promise<void> {
    await this.request("mcp_reconnect", { serverName });
    this.refreshPanel(["mcp"]);
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

  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    await this.request("mcp_toggle", { serverName, enabled });
    this.refreshPanel(["mcp"]);
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

  answerPermission(request: PermissionRequest, answer: PermissionAnswer): Promise<void> {
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
          updatedPermissions: request.suggestions,
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
    return this.write({
      type: "control_response",
      response: { subtype: "success", request_id: request.requestId, response: body },
    });
  }

  /** Sends a control request and waits for its answer. */
  request(subtype: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.supports(subtype)) {
      return Promise.reject(new Error(`${subtype} needs a newer Claude Code`));
    }
    const id = nextRequestId();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${subtype} got no answer`));
      }, CONTROL_TIMEOUT_MS);
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

function startChat(args: StartArgs & { workspaceId: string; tabId: string; cwd: string }) {
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

function ensureListeners(): void {
  if (listening) return;
  listening = true;
  ipcListen("chat", "line", (line) => {
    const controller = controllers.get(chatKey(line.workspaceId, line.tabId));
    controller?.receive(line as ChatLine);
  });
  ipcListen("chat", "held", ({ workspaceId }) => {
    for (const controller of controllers.values()) {
      if (controller.key.startsWith(`${workspaceId}:`)) controller.held();
    }
  });
  ipcListen("chat", "resync", ({ workspaceId }) => {
    for (const controller of controllers.values()) {
      if (controller.key.startsWith(`${workspaceId}:`)) void controller.resync();
    }
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
