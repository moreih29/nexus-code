import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import {
  type AccountEvent,
  ALL_DEVICES,
  type Capability,
  type ClientFrame,
  type Delivered,
  EPOCH_BYTES,
  FILE_GRANTS_SCHEMA,
  type Hello,
  isRpcMethod,
  MAX_FRAME_BYTES,
  olderConnection,
  PAIR_KID,
  PROTOCOL_VERSION,
  REQUEST_CANCEL,
  type RelayError,
  RequestCancelSchema,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  type RpcError,
  RpcErrorCode,
  type RpcMethod,
  type RpcNotificationMethod,
  type RpcNotificationParams,
  type RpcParams,
  type RpcRequest,
  type RpcResult,
  SCHEMA_VERSION,
  type SealedMessage,
  type SenderConnection,
  type ServerFrame,
  UNTIMED_CONSENT_SCHEMA,
} from "../../../../packages/remote-protocol/src";
import { PEER_USAGE_REFRESH_TIMEOUT_MS } from "../../../shared/cli/ui";
import { createLogger } from "../../../shared/log/main";
import {
  type RoomPeer,
  type RoomState,
  type RoomStatus,
  speaks,
} from "../../../shared/remote/room";
import { shortId } from "../../../shared/util/short-id";
import {
  validationErrorMessage,
  validationErrorOptions,
} from "../../../shared/validation/error-message";
import { frameStallDeadline } from "./frame-stall";
import { type FrameKind, FramePriority, OutgoingFrames } from "./outgoing";
import {
  type RelayConnectionDeps,
  type RelayRecoveryReason,
  type RelayStatus,
  type RelayStopReason,
  SOCKET_OPEN_TIMEOUT_MS,
} from "./relay-connection";
import { openMessage, type RoomKey, sealMessage } from "./seal";

const log = createLogger("remote-room");

export const REQUEST_TIMEOUT_MS = 30_000;
const SLOW_SERVING_MS = 15_000;
const REPLY_RATE_LIMIT_WINDOW_MS = 15_000;
const HELD_CHAT_REQUEST_MS = 70_000;
const HELD_CHAT_REQUESTS: ReadonlySet<RpcMethod> = new Set([
  "chat.configure",
  "chat.command",
  "chat.profile",
  "chat.new",
  "chat.config",
  "chat.mcp",
  "chat.remoteControl",
]);
const HELLO_RETRY_INTERVAL_MS = 5_000;
const HELLO_WAIT_MS = 3_000;
export const ROOM_READY_WAIT_MS = 3_000;
const WARNING_INTERVAL_MS = 30_000;
const RECENT_REPLY_LIMIT = 200;
const PEER_PROBE_MS = 5_000;
export const PEER_GONE_GRACE_MS = 5_000;
const MAX_PROBE_PEERS = 3;

type RoomWarning =
  | "stale-epoch"
  | "request-timeout"
  | `request-retry-${RetryReason}`
  | "slow-serving"
  | "relay-error"
  | "queue-drop"
  | "queue-stall";

const PHONE_PLATFORMS = new Set(["ios", "android", "web"]);

export const FOREIGN_KEY_INTERVAL_MS = 60_000;

const MAX_PAST_EPOCHS = 4096;

function newEpoch(): string {
  return randomBytes(EPOCH_BYTES).toString("base64url");
}

function requestWait<M extends RpcMethod>(method: M, params: RpcParams<M>): number {
  if (method === "profiles.usage" && (params as RpcParams<"profiles.usage">).refresh) {
    return PEER_USAGE_REFRESH_TIMEOUT_MS;
  }
  return HELD_CHAT_REQUESTS.has(method) ? HELD_CHAT_REQUEST_MS : REQUEST_TIMEOUT_MS;
}

export const MAX_MESSAGE_BYTES = Math.floor(((MAX_FRAME_BYTES - 1024) * 3) / 4) - 64;

export function fitsInFrame(message: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_MESSAGE_BYTES;
}

class FileReadBudget {
  private active = 0;
  private waiting: Array<{ current: () => boolean; resume: (acquired: boolean) => void }> = [];

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
  ) {}

  async acquire(current: () => boolean): Promise<boolean> {
    if (this.active < this.limit) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= this.queueLimit) return false;
    return new Promise<boolean>((resume) => this.waiting.push({ current, resume }));
  }

  cancelWaiting(): void {
    this.waiting = this.waiting.filter((waiter) => {
      if (waiter.current()) return true;
      waiter.resume(false);
      return false;
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next.resume(true);
    else this.active--;
  }
}

const FILE_READ_SOCKET_HIGH_WATER = 4 * MAX_FRAME_BYTES;
const FILE_READ_SOCKET_WAIT_MS = 8_000;

const BULK_FRAMES = new Set([
  "files.read",
  "files.write.chunk",
  "chat.image",
  "chat.attach",
  "notes.attach",
]);
const LARGE_READ_REPLY_BYTES = 64 * 1024;
const LARGE_READ_REPLIES = new Set([
  "profiles.list",
  "profiles.usage",
  "chat.panel",
  "chat.tool",
  "chat.instructions",
  "settings.instructions",
  "chat.entryItem",
  "history.list",
  "notes.list",
  "notes.read",
  "notes.transcript",
  "notes.voiceNames.list",
  "notes.voiceSuggestions.list",
  "layout.get",
  "agentView.get",
  "browser.permissions",
]);
const RATE_LIMITED = "the relay is rate limiting this connection";

const RETRYABLE_READS: ReadonlySet<RpcMethod> = new Set([
  "sessions.list",
  "events.read",
  "profiles.list",
  "profiles.usage",
  "folders.list",
  "history.list",
  "chat.read",
  "chat.peek",
  "chat.settings",
  "chat.commands",
  "chat.panel",
  "chat.tool",
  "chat.instructions",
  "settings.instructions",
  "chat.entryItem",
  "chat.original",
  "chat.wait",
  "chat.image",
  "chat.fileSuggestions",
  "chat.runs",
  "chat.run",
  "chat.runRead",
  "chat.rewindPreview",
  "terminal.read",
  "terminal.wait",
  "terminal.shells",
  "files.list",
  "files.read",
  "files.resolve",
  "files.grant",
  "files.find",
  "files.search",
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
  "notes.list",
  "notes.read",
  "notes.transcript",
  "notes.voiceNames.list",
  "layout.get",
  "agentView.get",
  "browser.permissions",
]);

function readsWholeImage(params: unknown): boolean {
  const { as, path } = (params ?? {}) as { as?: unknown; path?: unknown };
  const image = /\.(png|jpe?g|gif|webp)$/i;
  return (
    as !== "bytes" &&
    typeof path === "string" &&
    (image.test(posix.normalize(path).replace(/\/+$/, "")) ||
      image.test(win32.normalize(path).replace(/\\+$/, "")))
  );
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RoomConnection {
  start(): void;
  stop(reason?: RelayStopReason): void;
  send(frame: ClientFrame): boolean;
  readonly bufferedAmount?: number;
  healthy(): void;
  recover(reason: RelayRecoveryReason): void;
}

export interface RemoteRoomDeps {
  readonly self: { id: string; name: string; platform: string };
  readonly room: RoomKey;
  readonly app: { name: string; version: string };
  readonly theme?: () => string | undefined;
  readonly serves: readonly Capability[] | (() => readonly Capability[]);
  connect(
    handlers: Pick<RelayConnectionDeps, "onOpen" | "onFrame" | "onStatus" | "onSignedOut">,
  ): RoomConnection;
  serve(request: {
    from: string;
    id: RpcRequest["id"];
    method: RpcMethod;
    params: unknown;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    waits?: boolean;
    epoch?: string;
    grants?: boolean;
  }): Promise<unknown>;
  onChange(state: RoomState): void;
  onDisconnect?(peer?: string): void;
  onPresence?(peers: readonly RoomPeer[]): void;
  onNotification?(from: string, method: string, params: unknown): void;
  onForeignKey?(kid: number): void;
  onAccountEvent?(event: AccountEvent): void;
  onPairFrame?(frame: Delivered): void;
  onSignedOut(): void;
  readonly requestTimeoutMs?: number;
}

type OutboundRequest = RpcRequest & { id: number; method: RpcMethod };
type RetryReason = "peer-rejoined" | "peer-unavailable" | "local-reconnected";

interface Pending {
  to: string;
  message: OutboundRequest;
  resolve(result: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  started: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  helloTimer?: ReturnType<typeof setTimeout>;
  attempt?: { peer: string; seq?: number };
  retryReason?: RetryReason;
  retried: boolean;
}

interface Serving {
  readonly from: string;
  readonly controller: AbortController;
}

interface SentReply {
  from: string;
  epoch: string;
  id: number | string;
  method: string;
  sentAt: number;
}

export class RemoteRoom {
  private readonly connection: RoomConnection;
  private readonly imageReadBudget = new FileReadBudget(2, 16);
  private readonly fileReadBudget = new FileReadBudget(8, 32);
  private status: RoomStatus = "off";
  private peers = new Map<string, RoomPeer>();
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readyWaiters = new Set<(ready: boolean) => void>();
  private seq = 0;
  private greeted = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly gone = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly serving = new Map<string, Serving>();
  private epoch = newEpoch();
  private conn: SenderConnection = { boot: newEpoch(), n: 1 };
  private readonly heard = new Map<
    string,
    { epoch: string; seq: number; conn?: SenderConnection; departed?: true }
  >();
  private readonly past = new Set<string>();
  private outbox = this.makeOutbox();
  private readonly sentReplies = new Map<number, SentReply>();
  private inbox = { tail: Promise.resolve(), pending: 0 };
  private readonly helloRetryAt = new Map<string, number>();
  private broadcastHelloAt = -Infinity;
  private readonly warnedAt = new Map<RoomWarning, number>();
  private droppedFrames = 0;
  private rateLimitedFrames = 0;
  private readonly retriedRequests = new Map<RetryReason, number>();
  private probe: { peers: Set<string>; timer: ReturnType<typeof setTimeout> } | undefined;
  private foreignAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: RemoteRoomDeps) {
    this.connection = deps.connect({
      onOpen: () => {
        this.renew("the connection to the room was lost");
        this.seq = 0;
        this.greeted = false;
        this.presenceTimer = setTimeout(
          () => this.connection.recover("presence-timeout"),
          SOCKET_OPEN_TIMEOUT_MS,
        );
        this.presenceTimer.unref?.();
      },
      onFrame: (frame) => this.onFrame(frame),
      onStatus: (status) => this.onStatus(status),
      onSignedOut: () => deps.onSignedOut(),
    });
  }

  start(): void {
    this.connection.start();
  }

  stop(reason?: RelayStopReason): void {
    this.clearPresenceTimer();
    this.connection.stop(reason);
    this.interruptRequests("left the room");
    this.disconnected();
    this.status = "off";
    this.resetQueues();
    this.cancelQueuedReads();
    this.changed();
  }

  private finishPending(p: Pending): boolean {
    if (this.pending.get(p.message.id) !== p) return false;
    this.pending.delete(p.message.id);
    clearTimeout(p.timer);
    clearTimeout(p.helloTimer);
    p.cleanup();
    return true;
  }

  private rejectPending(p: Pending, error: unknown): void {
    if (this.finishPending(p)) p.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private interrupted(p: Pending, why: string, sent = p.attempt?.seq !== undefined): RpcFailure {
    const outcome = sent ? "unknown" : "rejected";
    const data = RETRYABLE_READS.has(p.message.method) ? undefined : { outcome };
    return new RpcFailure(RpcErrorCode.Unavailable, why, data);
  }

  private interruptRequest(p: Pending, why: string, reason?: RetryReason): void {
    if (reason && !this.gone.has(p.to) && !p.retried && RETRYABLE_READS.has(p.message.method)) {
      if (p.attempt) {
        delete p.attempt;
        p.retryReason = reason;
      }
      return;
    }
    this.rejectPending(p, this.interrupted(p, why));
  }

  private interruptRequests(why: string, reason?: RetryReason): void {
    for (const p of this.pending.values()) this.interruptRequest(p, why, reason);
  }

  private renew(why: string): void {
    this.interruptRequests(why, "local-reconnected");
    this.disconnected();
    this.epoch = newEpoch();
    this.conn = { boot: this.conn.boot, n: this.conn.n + 1 };
    this.heard.clear();
    this.past.clear();
    this.helloRetryAt.clear();
    this.broadcastHelloAt = -Infinity;
    this.resetQueues();
    this.cancelQueuedReads();
  }

  state(): RoomState {
    return { status: this.status, peers: [...this.peers.values()] };
  }

  private connecting(): boolean {
    return this.status === "connecting" || this.status === "waiting";
  }

  async waitUntilReady(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!this.connecting()) return this.status === "online";
    const ready = await new Promise<boolean>((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve(ready);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), ROOM_READY_WAIT_MS);
      this.readyWaiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
    return ready;
  }

  private serves(): readonly Capability[] {
    const { serves } = this.deps;
    return typeof serves === "function" ? serves() : serves;
  }

  announce(): void {
    if (this.status !== "online" || !this.greeted) return;
    for (const [id, { epoch }] of this.heard) {
      if (this.peers.get(id)?.online !== false) void this.post(id, epoch, this.hello(false));
    }
  }

  async request<M extends RpcMethod>(
    to: string,
    method: M,
    params: RpcParams<M>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>> {
    signal?.throwIfAborted();
    const id = this.nextId++;
    const message: OutboundRequest = { jsonrpc: "2.0", id, method, params };
    if (!fitsInFrame(message)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${method}: too large to send`);
    }
    const connecting = this.connecting();
    const known = connecting ? this.heard.get(to) : undefined;
    const awaitingReconnect = known !== undefined && !known.departed && RETRYABLE_READS.has(method);
    const ready = !connecting || awaitingReconnect || (await this.waitUntilReady(signal));
    const here = this.status === "online";
    if (!ready || (!here && !awaitingReconnect)) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "not in the room",
        method === "chat.send" ? { outcome: "rejected" } : undefined,
      );
    }
    const heard = this.heard.get(to);
    const peer = here && !heard?.departed ? heard?.epoch : undefined;
    const online = this.peers.get(to)?.online;
    if (here && (online === false || (!peer && online === undefined))) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "that device is not in the room",
        method === "chat.send" ? { outcome: "rejected" } : undefined,
      );
    }

    const started = performance.now();
    const wait = timeoutMs ?? this.deps.requestTimeoutMs ?? requestWait(method, params);
    const answer = new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.callOff(p);
        this.rejectPending(p, signal?.reason);
      };
      const p: Pending = {
        to,
        message,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
        started,
        deadline: started + wait,
        timer: Number.isFinite(wait) ? setTimeout(() => this.timeoutRequest(p), wait) : undefined,
        retried: false,
      };
      this.pending.set(id, p);
      signal?.addEventListener("abort", abort, { once: true });
      if (peer) {
        this.sendRequest(p, peer);
      } else if (here) {
        p.helloTimer = setTimeout(() => {
          this.rejectPending(p, this.interrupted(p, "that device has not said hello yet"));
        }, HELLO_WAIT_MS);
        this.retryHello(to);
      }
    });
    return (await answer) as RpcResult<M>;
  }

  private callOff(p: Pending): void {
    if (this.pending.get(p.message.id) !== p || p.attempt?.seq === undefined) return;
    void this.post(
      p.to,
      p.attempt.peer,
      { jsonrpc: "2.0", method: REQUEST_CANCEL, params: { id: p.message.id } },
      { kind: "notification:request.cancel", priority: FramePriority.Request },
    );
  }

  private peerLeft(peer: string): void {
    const heard = this.heard.get(peer);
    if (heard) heard.departed = true;
    this.helloRetryAt.delete(peer);
    for (const p of this.pending.values()) {
      if (p.to === peer) clearTimeout(p.helloTimer);
    }
    this.gone.set(
      peer,
      setTimeout(() => this.finishPeerDeparture(peer), PEER_GONE_GRACE_MS),
    );
  }

  private finishPeerDeparture(peer: string): void {
    clearTimeout(this.gone.get(peer));
    this.gone.delete(peer);
    for (const p of this.pending.values()) {
      if (p.to === peer)
        this.rejectPending(p, this.interrupted(p, "that device is not in the room"));
    }
  }

  private disconnected(peer?: string): void {
    for (const [key, serving] of this.serving) {
      if (peer !== undefined && serving.from !== peer) continue;
      this.serving.delete(key);
      serving.controller.abort(
        new RpcFailure(RpcErrorCode.Unavailable, "the requesting device left the room"),
      );
    }
    this.deps.onDisconnect?.(peer);
  }

  private async answerServing(
    from: string,
    epoch: string,
    message: RpcRequest,
    current: () => boolean,
  ): Promise<{ result: unknown } | { error: RpcError }> {
    const key = servingKey(from, epoch, message.id);
    const controller = new AbortController();
    this.serving.set(key, { from, controller });
    try {
      return await this.answer(from, epoch, message, current, controller.signal);
    } finally {
      if (this.serving.get(key)?.controller === controller) this.serving.delete(key);
    }
  }

  private timeoutRequest(p: Pending): void {
    if (!this.finishPending(p)) return;
    const {
      to,
      attempt,
      started,
      message: { method },
    } = p;
    p.reject(this.interrupted(p, `${method}: no answer in time`));
    this.warnOccasionally(
      "request-timeout",
      `Remote request timed out method=${method} peer=${shortId(to)} elapsedMs=${Math.round(performance.now() - started)}`,
    );
    if (attempt?.seq !== undefined && !this.gone.has(to)) {
      this.retryHello(to, this.heard.get(to)?.epoch ?? attempt.peer);
      this.probePeerPath(to);
    }
  }

  private sendRequest(p: Pending, peer: string): void {
    if (performance.now() >= p.deadline) {
      this.timeoutRequest(p);
      return;
    }
    const { to, retryReason } = p;
    const { method } = p.message;
    if (retryReason) {
      this.pending.delete(p.message.id);
      p.message = { ...p.message, id: this.nextId++ };
      this.pending.set(p.message.id, p);
      p.retried = true;
      delete p.retryReason;
      if (!fitsInFrame(p.message)) {
        this.rejectPending(
          p,
          new RpcFailure(RpcErrorCode.InvalidParams, `${method}: too large to send`),
        );
        return;
      }
    }
    clearTimeout(p.helloTimer);
    delete p.helloTimer;
    const attempt: NonNullable<Pending["attempt"]> = { peer };
    p.attempt = attempt;
    const current = () => this.pending.get(p.message.id) === p && p.attempt === attempt;
    void this.post(to, peer, p.message, {
      kind: `request:${method}`,
      priority:
        method === "files.read"
          ? FramePriority.Request
          : this.bulkPriority(method, FramePriority.Request),
      wanted: () => current() && !this.gone.has(to) && performance.now() < p.deadline,
      onSending: (seq) => {
        attempt.seq = seq;
        if (retryReason) this.logRetry(p, retryReason);
      },
    }).then(
      (seq) => {
        if (seq !== null || !current() || this.gone.has(to)) return;
        if (performance.now() >= p.deadline) {
          this.timeoutRequest(p);
          return;
        }
        const why = this.status === "online" ? "the relay send queue is busy" : "not in the room";
        this.rejectPending(p, this.interrupted(p, why, false));
      },
      (error) => {
        if (current()) this.rejectPending(p, error);
      },
    );
  }

  private logRetry(p: Pending, reason: RetryReason): void {
    const count = (this.retriedRequests.get(reason) ?? 0) + 1;
    const logged = this.warnOccasionally(
      `request-retry-${reason}`,
      `Remote read retried method=${p.message.method} peer=${shortId(p.to)} reason=${reason} attempt=2 count=${count}`,
    );
    this.retriedRequests.set(reason, logged ? 0 : count);
  }

  private resumeRequests(from: string, epoch: string): void {
    if (this.gone.has(from)) return;
    for (const p of this.pending.values()) {
      if (p.to === from && !p.attempt) this.sendRequest(p, epoch);
    }
  }

  async notify<M extends RpcNotificationMethod>(
    to: string,
    method: M,
    params: RpcNotificationParams<M>,
  ): Promise<boolean> {
    const message: SealedMessage = { jsonrpc: "2.0", method, params };
    const peer = this.heard.get(to)?.epoch;
    if (!peer || !fitsInFrame(message)) return false;
    return (
      (await this.post(to, peer, message, {
        kind: `notification:${method}`,
        priority: FramePriority.Watch,
        ...(method === "sessions.update"
          ? { snapshotKey: `${to}|${method}|${params.watchId}` }
          : {}),
      })) !== null
    );
  }

  async sendPair(
    to: string,
    seal: (routing: { from: string; to: string; seq: number }) => Promise<{
      nonce: string;
      box: string;
    }>,
  ): Promise<boolean> {
    const epoch = this.epoch;
    const sent = await this.outbox.push({
      kind: "pairing",
      priority: FramePriority.Hello,
      wanted: () => this.epoch === epoch && this.status === "online",
      send: async (current) => {
        const seq = ++this.seq;
        const sealed = await seal({ from: this.deps.self.id, to, seq });
        return current() && this.connection.send({ t: "send", to, seq, kid: PAIR_KID, ...sealed })
          ? seq
          : null;
      },
    });
    return sent !== null;
  }

  private post(
    to: string,
    peer: string | null,
    message: SealedMessage,
    options: {
      kind: FrameKind;
      priority: FramePriority;
      wanted?: () => boolean;
      snapshotKey?: string;
      onSending?: (seq: number) => void;
    } = { kind: "hello", priority: FramePriority.Hello },
  ): Promise<number | null> {
    const { epoch, conn } = this;
    const sent = this.outbox.push({
      kind: options.kind,
      priority: options.priority,
      ...(options.snapshotKey ? { snapshotKey: options.snapshotKey } : {}),
      wanted: () => this.status === "online" && options.wanted?.() !== false,
      send: async (current) => {
        const seq = ++this.seq;
        const frame = await sealMessage({
          room: this.deps.room,
          from: this.deps.self.id,
          to,
          seq,
          envelope: { epoch, conn, peer, message },
        });
        if (!current()) return null;
        options.onSending?.(seq);
        return this.connection.send(frame) ? seq : null;
      },
    });
    void sent.catch(() => {});
    return sent;
  }

  private bulkPriority(method: string, otherwise: FramePriority): FramePriority {
    return BULK_FRAMES.has(method) ? FramePriority.Data : otherwise;
  }

  private makeOutbox(): OutgoingFrames {
    return new OutgoingFrames(
      () => {
        this.droppedFrames++;
        if (
          this.warnOccasionally(
            "queue-drop",
            `Relay send queue dropped frames count=${this.droppedFrames} queuedFrames=${this.outbox.size}`,
          )
        ) {
          this.droppedFrames = 0;
        }
      },
      (elapsed) => this.stalled("outbox", elapsed, this.outbox.size + 1),
      () => this.canSendData(),
    );
  }

  private resetQueues(): void {
    for (const timer of this.gone.values()) clearTimeout(timer);
    this.gone.clear();
    this.inbox = { tail: Promise.resolve(), pending: 0 };
    this.outbox.close();
    this.outbox = this.makeOutbox();
    this.sentReplies.clear();
    this.clearProbe();
  }

  private stalled(queue: "inbox" | "outbox", elapsed: number, frames: number): void {
    this.warnOccasionally(
      "queue-stall",
      `Relay reconnect reason=${queue}-stalled elapsedMs=${Math.round(elapsed)} queuedFrames=${frames} pendingRequests=${this.pending.size}`,
    );
    this.connection.recover(`${queue}-stalled`);
  }

  private probePeerPath(to: string): void {
    if (this.probe || this.status !== "online") return;
    const peers = new Set<string>();
    for (const id of [to, ...this.heard.keys()]) {
      if (this.peers.get(id)?.online) peers.add(id);
      if (peers.size === MAX_PROBE_PEERS) break;
    }
    if (peers.size < 2) return;
    const started = performance.now();
    this.probe = {
      peers,
      timer: setTimeout(() => {
        this.clearProbe();
        const stillOnline = [...peers].filter((id) => this.peers.get(id)?.online).length;
        if (stillOnline < 2) return;
        this.warnOccasionally(
          "queue-stall",
          `Relay reconnect reason=peer-probes-unanswered elapsedMs=${Math.round(performance.now() - started)} peers=${stillOnline} queuedFrames=${this.outbox.size} pendingRequests=${this.pending.size}`,
        );
        this.connection.recover("peer-probes-unanswered");
      }, PEER_PROBE_MS),
    };
    for (const id of peers) {
      const epoch = this.heard.get(id)?.epoch;
      if (epoch) this.retryHello(id, epoch);
    }
  }

  private clearProbe(): void {
    if (this.probe) clearTimeout(this.probe.timer);
    this.probe = undefined;
  }

  private themeNow(): { theme?: string } {
    const theme = this.deps.theme?.();
    return theme ? { theme } : {};
  }

  private hello(reply: boolean): Hello {
    return {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      device: this.deps.self,
      app: { ...this.deps.app, ...this.themeNow() },
      serves: [...this.serves()],
      schema: SCHEMA_VERSION,
      reply,
    };
  }

  private retryHello(to: string, epoch = this.heard.get(to)?.epoch): void {
    if (this.status !== "online" || this.peers.get(to)?.online !== true) return;
    const now = performance.now();
    if (!epoch) {
      if (now - this.broadcastHelloAt < HELLO_RETRY_INTERVAL_MS) return;
      this.broadcastHelloAt = now;
      void this.post(ALL_DEVICES, null, this.hello(true));
      return;
    }
    if (now - (this.helloRetryAt.get(to) ?? -Infinity) < HELLO_RETRY_INTERVAL_MS) return;
    this.helloRetryAt.set(to, now);
    void this.post(to, epoch, this.hello(true));
  }

  private warnOccasionally(kind: RoomWarning, message: string): boolean {
    const now = performance.now();
    if (now - (this.warnedAt.get(kind) ?? -Infinity) < WARNING_INTERVAL_MS) return false;
    this.warnedAt.set(kind, now);
    log.warn(message);
    return true;
  }

  private onStatus(status: RelayStatus): void {
    if (status === "online") return;
    this.clearPresenceTimer();
    const wasOnline = this.status === "online";
    this.status = status;
    const reconnecting = this.connecting();
    if (wasOnline || !reconnecting) {
      this.interruptRequests(
        status === "stopped" ? "left the room" : "the connection to the room was lost",
        reconnecting ? "local-reconnected" : undefined,
      );
    }
    if (wasOnline) this.resetQueues();
    this.disconnected();
    for (const peer of this.peers.values()) peer.online = false;
    this.cancelQueuedReads();
    this.changed();
  }

  private clearPresenceTimer(): void {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.t === "presence") {
      if (this.status !== "online" && this.presenceTimer === undefined) return;
      this.clearPresenceTimer();
      this.connection.healthy();
      const next = new Map<string, RoomPeer>();
      for (const d of frame.devices) {
        if (d.id === frame.self) continue;
        const known = this.peers.get(d.id);
        next.set(d.id, {
          id: d.id,
          name: d.alias || d.name,
          ...(d.alias ? { hostName: d.name } : {}),
          platform: d.platform,
          online: d.online,
          ...(known?.app ? { app: known.app } : {}),
          ...(known?.serves ? { serves: known.serves } : {}),
          ...(known?.online && known.schema ? { schema: known.schema } : {}),
          ...(known?.rejoins ? { rejoins: known.rejoins } : {}),
        });
      }
      for (const peer of this.peers.values()) {
        if (peer.online && !next.get(peer.id)?.online) {
          this.disconnected(peer.id);
          this.peerLeft(peer.id);
        }
      }
      for (const id of this.gone.keys()) {
        if (next.get(id)?.online) this.finishPeerDeparture(id);
      }
      const previous = this.peers;
      this.peers = next;
      this.status = "online";
      this.deps.onPresence?.([...next.values()]);
      for (const id of this.helloRetryAt.keys()) if (!next.has(id)) this.helloRetryAt.delete(id);
      this.cancelQueuedReads();
      if (!this.greeted) {
        this.greeted = true;
        void this.post(ALL_DEVICES, null, this.hello(true));
      } else {
        for (const p of this.pending.values()) {
          if (!p.attempt && !previous.get(p.to)?.online) this.retryHello(p.to);
        }
      }
      this.changed();
      return;
    }
    if (frame.t === "message") {
      const inbox = this.inbox;
      inbox.pending++;
      inbox.tail = inbox.tail
        .then(() => this.take(frame, inbox))
        .catch(() => log.warn("Could not process a relay message"))
        .finally(() => {
          inbox.pending--;
        });
      return;
    }
    if (frame.t === "account") {
      this.deps.onAccountEvent?.(frame);
      return;
    }
    this.relayError(frame);
  }

  private relayError({ code, seq }: RelayError): void {
    if (code === "unauthorized") return;
    const limited = code === "rate-limited";
    if (limited) {
      this.rateLimitedFrames++;
      this.outbox.rateLimited();
      this.clearProbe();
    }
    if (
      code !== "no-such-device" &&
      this.warnOccasionally(
        "relay-error",
        `Relay rejected frame code=${code} rateLimited=${this.rateLimitedFrames} queuedFrames=${this.outbox.size} pendingRequests=${this.pending.size}`,
      )
    )
      this.rateLimitedFrames = 0;
    if (seq === undefined) return;

    for (const p of this.pending.values()) {
      if (p.attempt?.seq !== seq) continue;
      if (
        code === "no-such-device" &&
        !this.gone.has(p.to) &&
        !p.retried &&
        RETRYABLE_READS.has(p.message.method)
      ) {
        this.interruptRequest(p, "that device is not in the room", "peer-unavailable");
        this.retryHello(p.to);
        return;
      }
      const why = limited
        ? RATE_LIMITED
        : code === "no-such-device"
          ? "that device is not in the room"
          : "the relay rejected the request frame";
      this.rejectPending(p, this.interrupted(p, why, false));
      return;
    }
    const reply = this.sentReplies.get(seq);
    this.sentReplies.delete(seq);
    if (limited && reply && performance.now() - reply.sentAt < REPLY_RATE_LIMIT_WINDOW_MS) {
      this.rejectReply(reply.from, reply.epoch, reply, RATE_LIMITED);
    }
  }

  private async take(frame: Delivered, inbox: RemoteRoom["inbox"]): Promise<void> {
    if (inbox !== this.inbox || this.status !== "online") return;
    if (frame.to !== this.deps.self.id && frame.to !== ALL_DEVICES) return;
    if (frame.kid === PAIR_KID) {
      if (frame.to === this.deps.self.id) this.deps.onPairFrame?.(frame);
      return;
    }
    const { expiry, cancel } = frameStallDeadline((elapsed) => {
      if (inbox === this.inbox) this.stalled("inbox", elapsed, inbox.pending);
    });
    const envelope = await Promise.race([expiry, openMessage(this.deps.room, frame)]).finally(
      cancel,
    );
    if (inbox !== this.inbox) return;
    if (!envelope) {
      if (frame.kid > this.deps.room.kid) this.foreignKey(frame.kid);
      return;
    }
    const { message } = envelope;
    const hello = "type" in message ? message : null;
    if (hello && hello.device.id !== frame.from) return;
    if (frame.to === ALL_DEVICES || envelope.peer !== this.epoch) {
      if (hello) void this.post(frame.from, envelope.epoch, this.hello(true));
      else if (frame.to === this.deps.self.id && "method" in message && "id" in message) {
        const method = isRpcMethod(message.method) ? message.method : "unknown";
        this.warnOccasionally(
          "stale-epoch",
          `Dropped request for stale epoch method=${method} peer=${shortId(frame.from)}`,
        );
        if (!this.past.has(`${frame.from}|${envelope.epoch}`)) {
          this.retryHello(frame.from, envelope.epoch);
        }
      }
      return;
    }
    if (!this.fresh(frame.from, envelope.epoch, frame.seq, envelope.conn)) return;
    void this.handle(frame.from, envelope.epoch, message, this.epoch).catch(() => {
      this.warnOccasionally("relay-error", "Could not handle a remote room message");
    });
  }

  private fresh(from: string, epoch: string, seq: number, conn?: SenderConnection): boolean {
    const heard = this.heard.get(from);
    if (heard?.epoch === epoch) {
      if (seq <= heard.seq) return false;
    } else {
      if (this.past.has(`${from}|${epoch}`)) return false;
      if (olderConnection(conn, heard?.conn)) return false;
      if (heard) this.past.add(`${from}|${heard.epoch}`);
    }
    this.heard.set(from, { ...heard, epoch, seq, conn });
    if (this.past.size > MAX_PAST_EPOCHS) {
      this.renew("the room started over");
      void this.post(ALL_DEVICES, null, this.hello(true));
      return false;
    }
    if (heard && heard.epoch !== epoch) this.rejoined(from, epoch);
    return true;
  }

  private rejoined(from: string, epoch: string): void {
    for (const p of this.pending.values()) {
      if (p.to === from && p.attempt && p.attempt.peer !== epoch) {
        this.interruptRequest(p, "the device reconnected to the room", "peer-rejoined");
      }
    }
    this.disconnected(from);
    this.cancelQueuedReads();
    const peer = this.peers.get(from);
    if (!peer) return;
    this.peers.set(from, { ...peer, rejoins: (peer.rejoins ?? 0) + 1 });
    this.changed();
  }

  private foreignKey(kid: number): void {
    const now = Date.now();
    if (now - this.foreignAt < FOREIGN_KEY_INTERVAL_MS) return;
    this.foreignAt = now;
    this.deps.onForeignKey?.(kid);
  }

  private async handle(
    from: string,
    epoch: string,
    message: SealedMessage,
    localEpoch: string,
  ): Promise<void> {
    if ("type" in message) {
      if (!message.reply && this.probe?.peers.has(from)) this.clearProbe();
      const peer = this.peers.get(from) ?? {
        id: from,
        name: message.device.name,
        platform: message.device.platform,
        online: true,
      };
      this.peers.set(from, {
        ...peer,
        app: message.app,
        serves: message.serves,
        ...(message.schema ? { schema: message.schema } : {}),
      });
      this.changed();
      if (message.reply) void this.post(from, epoch, this.hello(false));
      if (peer.online && !this.gone.has(from)) {
        const heard = this.heard.get(from);
        if (heard) delete heard.departed;
        this.resumeRequests(from, epoch);
      }
      return;
    }
    if ("method" in message && "id" in message) {
      const current = () =>
        this.status === "online" &&
        this.epoch === localEpoch &&
        this.heard.get(from)?.epoch === epoch &&
        this.peers.get(from)?.online === true;
      if (message.method === "files.read" || message.method === "files.resolve") {
        const budget = readsWholeImage(message.params) ? this.imageReadBudget : this.fileReadBudget;
        if (!current()) return;
        if (!(await budget.acquire(current))) {
          if (!current()) return;
          await this.reply(
            from,
            epoch,
            message,
            {
              error: {
                code: RpcErrorCode.Unavailable,
                message: "the host is busy reading files",
              },
            },
            current,
          );
          return;
        }
        try {
          const writable = await this.waitForFileReadSocket(current);
          if (!current()) return;
          if (!writable) {
            this.rejectReply(from, epoch, message, "the relay send buffer is busy");
            return;
          }
          const answer = await this.answerServing(from, epoch, message, current);
          if (current()) await this.reply(from, epoch, message, answer, current);
        } finally {
          budget.release();
        }
        return;
      }
      if (!current()) return;
      const answer = await this.answerServing(from, epoch, message, current);
      if (current()) await this.reply(from, epoch, message, answer, current);
      return;
    }
    if ("method" in message) {
      const method = message.method;
      if (method === REQUEST_CANCEL) {
        const cancel = RequestCancelSchema.safeParse(message.params);
        if (cancel.success) this.callOffServing(servingKey(from, epoch, cancel.data.id));
        return;
      }
      if (!Object.hasOwn(RPC_NOTIFICATIONS, method)) return;
      const parsed = RPC_NOTIFICATIONS[method as RpcNotificationMethod].safeParse(message.params);
      if (parsed.success) this.deps.onNotification?.(from, method, parsed.data);
      return;
    }
    const p = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!p || p.to !== from || p.attempt?.peer !== epoch || p.attempt.seq === undefined) return;
    if (performance.now() >= p.deadline) {
      this.timeoutRequest(p);
      return;
    }
    if (this.probe?.peers.has(from)) this.clearProbe();
    this.finishPending(p);
    if ("error" in message) {
      p.reject(new RpcFailure(message.error.code, message.error.message, message.error.data));
      return;
    }
    const result = RPC_METHODS[p.message.method].result.safeParse(message.result);
    if (result.success) p.resolve(result.data);
    else
      p.reject(
        new RpcFailure(
          RpcErrorCode.InternalError,
          `${p.message.method}: an answer not of the protocol`,
        ),
      );
  }

  private canSendData(): boolean {
    return (this.connection.bufferedAmount ?? 0) <= FILE_READ_SOCKET_HIGH_WATER;
  }

  private async waitForFileReadSocket(current: () => boolean): Promise<boolean> {
    const started = performance.now();
    while (current() && !this.canSendData()) {
      if (performance.now() - started >= FILE_READ_SOCKET_WAIT_MS) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    return current();
  }

  private async reply(
    from: string,
    epoch: string,
    request: { id: number | string; method: string },
    answer: { result: unknown } | { error: RpcError },
    current?: () => boolean,
  ): Promise<number | null> {
    const reply: SealedMessage = { jsonrpc: "2.0", id: request.id, ...answer };
    const bytes = Buffer.byteLength(JSON.stringify(reply), "utf8");
    const fits = bytes <= MAX_MESSAGE_BYTES;
    let priority = FramePriority.Reply;
    if (fits && "result" in answer) {
      if (bytes >= LARGE_READ_REPLY_BYTES && LARGE_READ_REPLIES.has(request.method)) {
        priority = FramePriority.Data;
      } else {
        priority = this.bulkPriority(request.method, FramePriority.Reply);
      }
    }
    const localEpoch = this.epoch;
    const sent = await this.post(
      from,
      epoch,
      fits
        ? reply
        : {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: RpcErrorCode.InternalError,
              message: `${request.method}: the answer is too large to send`,
            },
          },
      {
        kind: `reply:${isRpcMethod(request.method) ? request.method : "unknown"}`,
        priority,
        ...(current ? { wanted: current } : {}),
        onSending: (seq) => {
          if (this.sentReplies.size >= RECENT_REPLY_LIMIT) {
            const oldest = this.sentReplies.keys().next().value;
            if (oldest !== undefined) this.sentReplies.delete(oldest);
          }
          this.sentReplies.set(seq, {
            from,
            epoch,
            id: request.id,
            method: request.method,
            sentAt: performance.now(),
          });
        },
      },
    );
    if (
      sent === null &&
      priority === FramePriority.Data &&
      this.epoch === localEpoch &&
      current?.() !== false
    ) {
      this.rejectReply(from, epoch, request, "the relay send queue is busy");
    }
    return sent;
  }

  private rejectReply(
    from: string,
    epoch: string,
    { id, method }: { id: number | string; method: string },
    message: string,
  ): void {
    if (this.status !== "online" || this.heard.get(from)?.epoch !== epoch) return;
    void this.post(
      from,
      epoch,
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: RpcErrorCode.Unavailable,
          message,
          ...(method === "chat.send" ? { data: { outcome: "unknown" } } : {}),
        },
      },
      { kind: `reply:${isRpcMethod(method) ? method : "unknown"}`, priority: FramePriority.Reply },
    );
  }

  private cancelQueuedReads(): void {
    this.imageReadBudget.cancelWaiting();
    this.fileReadBudget.cancelWaiting();
  }

  private callOffServing(key: string): void {
    const serving = this.serving.get(key);
    if (!serving) return;
    this.serving.delete(key);
    serving.controller.abort(
      new RpcFailure(RpcErrorCode.Unavailable, "the requesting device called it off"),
    );
  }

  private async answer(
    from: string,
    epoch: string,
    { id, method, params }: RpcRequest,
    isCurrent?: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ result: unknown } | { error: RpcError }> {
    if (!isRpcMethod(method)) {
      return { error: { code: RpcErrorCode.MethodNotFound, message: `no method ${method}` } };
    }
    const spec = RPC_METHODS[method];
    const parsed = spec.params.safeParse(params ?? {}, validationErrorOptions);
    const byAgent =
      typeof params === "object" &&
      params !== null &&
      (params as { from?: unknown }).from !== undefined;
    if (byAgent && parsed.success && (parsed.data as { from?: unknown }).from === undefined) {
      return {
        error: { code: RpcErrorCode.Forbidden, message: `${method} is not taken from agents` },
      };
    }
    if (byAgent && PHONE_PLATFORMS.has(this.peers.get(from)?.platform ?? "")) {
      return {
        error: {
          code: RpcErrorCode.Forbidden,
          message: "agents' requests are not taken from a phone",
        },
      };
    }
    const serves = this.serves();
    const anywhere = parsed.success && (parsed.data as { anywhere?: true }).anywhere === true;
    const capability =
      anywhere && (method === "files.write.begin" || method === "files.mkdir")
        ? "terminal.control"
        : spec.capability;
    if (
      anywhere &&
      (method === "files.list" || method === "files.read") &&
      !serves.includes("terminal.control")
    ) {
      return {
        error: {
          code: RpcErrorCode.Forbidden,
          message: "file access outside the workspace requires terminal control",
        },
      };
    }
    if (
      !serves.includes(capability as Capability) ||
      (method === "chat.peek" && !serves.includes("chat.read"))
    ) {
      return { error: { code: RpcErrorCode.Forbidden, message: `${method} is not served here` } };
    }
    if (byAgent && !serves.includes("agents")) {
      return {
        error: {
          code: RpcErrorCode.Forbidden,
          message: "control by agents is off there (Settings › Remote)",
        },
      };
    }
    if (!parsed.success) {
      return {
        error: { code: RpcErrorCode.InvalidParams, message: validationErrorMessage(parsed.error) },
      };
    }
    const started = performance.now();
    const slow = setTimeout(() => {
      const elapsed = Math.round(performance.now() - started);
      this.warnOccasionally(
        "slow-serving",
        `Still serving remote request method=${method} peer=${shortId(from)} elapsedMs=${elapsed}`,
      );
    }, SLOW_SERVING_MS);
    slow.unref?.();
    try {
      return {
        result: await this.deps.serve({
          from,
          id,
          method,
          params: parsed.data,
          ...(isCurrent ? { isCurrent } : {}),
          ...(signal ? { signal } : {}),
          ...(speaks(this.peers.get(from)?.schema, UNTIMED_CONSENT_SCHEMA) ? { waits: true } : {}),
          epoch,
          ...(speaks(this.peers.get(from)?.schema, FILE_GRANTS_SCHEMA) ? { grants: true } : {}),
        }),
      };
    } catch (error) {
      if (error instanceof RpcFailure) {
        return {
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        };
      }
      log.warn(
        `Serving ${method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return {
        error: { code: RpcErrorCode.InternalError, message: "the device could not answer" },
      };
    } finally {
      clearTimeout(slow);
    }
  }

  private changed(): void {
    this.deps.onChange(this.state());
    if (!this.connecting()) {
      for (const finish of this.readyWaiters) finish(this.status === "online");
    }
  }
}

function servingKey(from: string, epoch: string, id: RpcRequest["id"]): string {
  return JSON.stringify([from, epoch, id]);
}
