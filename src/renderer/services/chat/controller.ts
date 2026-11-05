// One controller per Claude tab: starts or re-attaches to the tab's program,
// feeds its lines to the chat model, and writes the user's messages,
// control requests and permission answers to it.
//
// Every line, the app's own included, reaches the model as the agent sends
// it back (chat.line), so a live tab and one that replays the log after a
// window reload build the same view.

import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { historyModel, joinHistory } from "./history";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  type ImageBlock,
  type PermissionRequest,
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

export interface ChatTabTarget {
  workspaceId: string;
  tabId: string;
  cwd: string;
  /** The session the tab had, to go on with when its program is gone. */
  sessionId?: string;
  /** A tab opened as a fork of another session. */
  fork?: { sessionId: string; at?: string };
}

export interface ChatTabHooks {
  /** The session id the tab now has, to keep with the tab. */
  onSession?: (sessionId: string) => void;
  /** The first message of the conversation, for the tab's title. */
  onFirstMessage?: (text: string) => void;
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
    let replay: { found: boolean; running: boolean; truncated: boolean };
    try {
      replay = unwrapIpcResult(await ipcCallResult("chat", "replay", { workspaceId, tabId }));
    } catch (err) {
      this.update((prev) => ({ ...prev, phase: "failed", error: (err as Error).message }));
      return;
    }
    this.flushNow();
    if (replay.found) {
      this.titled = this.titled || this.state.model.items.some((item) => item.kind === "user");
      this.update((prev) => ({
        ...prev,
        phase: replay.running ? "ready" : "ended",
        truncated: replay.truncated,
      }));
      return;
    }
    // The agent has no log: a new tab, or one whose agent restarted.
    if (this.target.fork) {
      await this.start({
        resume: this.target.fork.sessionId,
        fork: true,
        resumeAt: this.target.fork.at,
      });
      this.target = { ...this.target, fork: undefined };
      return;
    }
    if (this.sessionId) {
      await this.loadTranscript(this.sessionId);
      await this.start({ resume: this.sessionId });
      return;
    }
    await this.start({});
  }

  private async loadTranscript(sessionId: string): Promise<void> {
    try {
      const result = unwrapIpcResult(
        await ipcCallResult("chat", "transcript", {
          workspaceId: this.target.workspaceId,
          sessionId,
        }),
      );
      if (!result.found) return;
      const history = historyModel(result.lines);
      this.titled = this.titled || history.items.some((item) => item.kind === "user");
      this.update((prev) => ({ ...prev, history: joinHistory(prev.history, history) }));
    } catch (err) {
      log.warn(`transcript of ${sessionId} not read: ${(err as Error).message}`);
    }
  }

  private async start(resume: {
    resume?: string;
    fork?: boolean;
    resumeAt?: string;
  }): Promise<boolean> {
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
      this.request("initialize", { hooks: null }).catch((err: Error) => {
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
    await this.start(this.sessionId ? { resume: this.sessionId } : {});
  }

  /** The agent is back: replay what the tab missed, or find its program gone. */
  async resync(): Promise<void> {
    const { workspaceId, tabId } = this.target;
    this.flushNow();
    let replay: { found: boolean; running: boolean; truncated: boolean };
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
    this.flushNow();
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
    return this.start(this.sessionId ? { resume: this.sessionId } : {});
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
      this.sessionId = model.sessionId;
      this.hooks.onSession?.(model.sessionId);
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

function startChat(args: {
  workspaceId: string;
  tabId: string;
  cwd: string;
  resume?: string;
  fork?: boolean;
  resumeAt?: string;
}) {
  return ipcCallResult("chat", "start", args).then(unwrapIpcResult);
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
