/**
 * This device in its account's room: it says hello as it joins and to each
 * device that does, keeps who is there, serves the requests the others
 * send it, and asks them its own (JSON-RPC, sealed; packages/remote-protocol).
 * It takes only what was sealed for it, now, and each message once: the
 * epochs and seqs of packages/remote-protocol's ./sealed.ts.
 */

import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import {
  type AccountEvent,
  ALL_DEVICES,
  type Capability,
  type ClientFrame,
  type Delivered,
  EPOCH_BYTES,
  type Hello,
  isRpcMethod,
  MAX_FRAME_BYTES,
  PAIR_KID,
  PROTOCOL_VERSION,
  type RelayError,
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
  type ServerFrame,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import type { RoomPeer, RoomState, RoomStatus } from "../../../shared/remote/room";
import { isFileTransferMethod } from "./file-io";
import { frameStallDeadline } from "./frame-stall";
import { type FrameKind, FramePriority, OutgoingFrames } from "./outgoing";
import type {
  RelayConnectionDeps,
  RelayRecoveryReason,
  RelayStatus,
  RelayStopReason,
} from "./relay-connection";
import { openMessage, type RoomKey, sealMessage } from "./seal";

const log = createLogger("remote-room");

/** How long an answer may take. */
export const REQUEST_TIMEOUT_MS = 15_000;
const HELLO_RETRY_INTERVAL_MS = 5_000;
const HELLO_WAIT_MS = 3_000;
const WARNING_INTERVAL_MS = 30_000;
const RECENT_REPLY_LIMIT = 200;
const PEER_PROBE_MS = 5_000;
const MAX_PROBE_PEERS = 3;

type RoomWarning =
  | "stale-epoch"
  | "request-timeout"
  | `request-retry-${RetryReason}`
  | "slow-serving"
  | "relay-error"
  | "queue-drop"
  | "queue-stall";

/** The platforms of phones, as the relay names a device's: no agent runs on one. */
const PHONE_PLATFORMS = new Set(["ios", "android", "web"]);

/** How often a message sealed with a newer key version may have the key fetched again. */
export const FOREIGN_KEY_INTERVAL_MS = 60_000;

/**
 * Most epochs of others it keeps as past, to take none of their messages
 * again; past it, it starts an epoch of its own, which no message sealed
 * before names.
 */
const MAX_PAST_EPOCHS = 4096;

function newEpoch(): string {
  return randomBytes(EPOCH_BYTES).toString("base64url");
}

/**
 * Most bytes a message may take as JSON before it is sealed: its sealed
 * box goes in the frame as base64url (4 characters for 3 bytes), beside
 * the frame's routing, all under MAX_FRAME_BYTES.
 */
export const MAX_MESSAGE_BYTES = Math.floor(((MAX_FRAME_BYTES - 1024) * 3) / 4) - 64;

/** Whether a message goes in one frame. */
export function fitsInFrame(message: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_MESSAGE_BYTES;
}

/** Keep whole-image reads from taking all the memory or blocking small previews. */
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
  "chat.panel",
  "chat.tool",
  "chat.instructions",
  "chat.entryItem",
  "history.list",
  "notes.list",
  "notes.read",
  "notes.transcript",
  "notes.voiceNames.list",
  "notes.voiceSuggestions.list",
  "layout.get",
  "agentView.get",
]);
const RATE_LIMITED = "the relay is rate limiting this connection";

/** Reads that can be repeated after a connection loss. Watches subscribe and voice suggestions can start analysis. */
const RETRYABLE_READS: ReadonlySet<RpcMethod> = new Set([
  "sessions.list",
  "events.read",
  "profiles.list",
  "folders.list",
  "history.list",
  "chat.read",
  "chat.settings",
  "chat.commands",
  "chat.panel",
  "chat.tool",
  "chat.instructions",
  "chat.entryItem",
  "chat.original",
  "chat.wait",
  "chat.image",
  "chat.fileSuggestions",
  "chat.runs",
  "chat.run",
  "chat.rewindPreview",
  "terminal.read",
  "terminal.wait",
  "terminal.shells",
  "files.list",
  "files.read",
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

/** A request that failed, with its JSON-RPC error. */
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** What the room needs of the socket (RelayConnection). */
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
  /** The app's color theme now, by its id, which its hello says; it may change (see announce). */
  readonly theme?: () => string | undefined;
  /** What this device serves of its sessions, as its hello says; it may change (see announce). */
  readonly serves: readonly Capability[] | (() => readonly Capability[]);
  /** Makes the socket, telling it what to call. */
  connect(
    handlers: Pick<RelayConnectionDeps, "onOpen" | "onFrame" | "onStatus" | "onSignedOut">,
  ): RoomConnection;
  /** Answers another device's request; a RpcFailure for an error it should see. */
  serve(request: {
    from: string;
    method: RpcMethod;
    params: unknown;
    isCurrent?: () => boolean;
  }): Promise<unknown>;
  onChange(state: RoomState): void;
  /** Drop device-owned work when a peer disconnects, or all work when this device does. */
  onDisconnect?(peer?: string): void;
  onNotification?(from: string, method: string, params: unknown): void;
  /**
   * A message sealed with a newer version of the account key came: it may
   * have been reset. Told at most once a minute.
   */
  onForeignKey?(kid: number): void;
  /** Something the server tells of the account (account keys v2): a rotation, a reset. */
  onAccountEvent?(event: AccountEvent): void;
  /** A pairing frame (kid PAIR_KID) sent to this device, which the room key does not open. */
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
  timer: ReturnType<typeof setTimeout>;
  helloTimer?: ReturnType<typeof setTimeout>;
  attempt?: { peer: string; seq?: number };
  retryReason?: RetryReason;
  retried: boolean;
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
  private seq = 0;
  private greeted = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** This connection's epoch: a message is taken only when sealed for it. */
  private epoch = newEpoch();
  /** Each other device's epoch now, and the seq of the last message taken of it. */
  private readonly heard = new Map<string, { epoch: string; seq: number }>();
  /** Others' epochs it took a newer one of, as "device|epoch": none of their messages is taken. */
  private readonly past = new Set<string>();
  private outbox = this.makeOutbox();
  private readonly sentReplies = new Map<number, SentReply>();
  /** Messages are taken one after another, so their seqs are checked in the order they came. */
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
        // A new connection: a new epoch, so nothing sealed before it is taken. It counts its
        // messages from 1, learns the others' epochs again, and says hello again; what it
        // asked before will not be answered in this epoch.
        this.renew("the connection to the room was lost");
        this.seq = 0;
        this.greeted = false;
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
    this.connection.stop(reason);
    this.interruptRequests("left the room");
    this.deps.onDisconnect?.();
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
    if (reason && !p.retried && RETRYABLE_READS.has(p.message.method)) {
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

  /** Starts a new epoch. A retained read must wait for a hello in this epoch. */
  private renew(why: string): void {
    this.interruptRequests(why, "local-reconnected");
    this.deps.onDisconnect?.();
    this.epoch = newEpoch();
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

  /** What this device serves now. */
  private serves(): readonly Capability[] {
    const { serves } = this.deps;
    return typeof serves === "function" ? serves() : serves;
  }

  /** Tells the room again what this device serves, or its theme, after it changed. */
  announce(): void {
    if (this.status !== "online" || !this.greeted) return;
    for (const [id, { epoch }] of this.heard) {
      if (this.peers.get(id)?.online !== false) void this.post(id, epoch, this.hello(false));
    }
  }

  /** Asks another device of the account; its answer, or a RpcFailure. */
  async request<M extends RpcMethod>(
    to: string,
    method: M,
    params: RpcParams<M>,
    /** How long to wait for the answer: longer for one the other device's user may be asked about. */
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>> {
    signal?.throwIfAborted();
    const id = this.nextId++;
    const message: OutboundRequest = { jsonrpc: "2.0", id, method, params };
    if (!fitsInFrame(message)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${method}: too large to send`);
    }
    const knownEpoch = this.heard.get(to)?.epoch;
    const here = this.status === "online";
    const peer = here ? knownEpoch : undefined;
    const online = this.peers.get(to)?.online;
    const awaitingReconnect =
      (this.status === "connecting" || this.status === "waiting") &&
      knownEpoch !== undefined &&
      RETRYABLE_READS.has(method);
    if (!here && !awaitingReconnect) {
      throw new RpcFailure(RpcErrorCode.Unavailable, "not in the room");
    }
    if (here && (online === false || (!peer && !online))) {
      throw new RpcFailure(RpcErrorCode.Unavailable, "that device is not in the room");
    }

    const started = performance.now();
    const wait = timeoutMs ?? this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const answer = new Promise<unknown>((resolve, reject) => {
      const abort = () => this.rejectPending(p, signal?.reason);
      const p: Pending = {
        to,
        message,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
        started,
        deadline: started + wait,
        timer: setTimeout(() => this.timeoutRequest(p), wait),
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
      `Remote request timed out method=${method} peer=${to.slice(0, 8)} elapsedMs=${Math.round(performance.now() - started)}`,
    );
    if (attempt?.seq !== undefined) {
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
      wanted: () => current() && performance.now() < p.deadline,
      onSending: (seq) => {
        attempt.seq = seq;
        if (retryReason) this.logRetry(p, retryReason);
      },
    }).then(
      (seq) => {
        if (seq !== null || !current()) return;
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
      `Remote read retried method=${p.message.method} peer=${p.to.slice(0, 8)} reason=${reason} attempt=2 count=${count}`,
    );
    this.retriedRequests.set(reason, logged ? 0 : count);
  }

  private resumeRequests(from: string, epoch: string): void {
    for (const p of this.pending.values()) {
      if (p.to === from && !p.attempt) this.sendRequest(p, epoch);
    }
  }

  /**
   * Tells another device something it asked to be told (a watched chat's
   * update); false when it could not go: out of the room, or too large.
   */
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

  /**
   * Sends one device a pairing frame (kid PAIR_KID), which `seal` seals for
   * its routing; whether it went.
   */
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

  /**
   * Seals and sends, for the receiver's epoch (`peer`; null only in a hello
   * to all); its seq, or null when it could not go.
   */
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
    const epoch = this.epoch;
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
          envelope: { epoch, peer, message },
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

  /** Pongs prove the socket reaches the relay. A hello round trip checks forwarding. */
  private probePeerPath(to: string): void {
    if (this.probe || this.status !== "online") return;
    const peers = new Set<string>();
    for (const id of [to, ...this.heard.keys()]) {
      if (this.peers.get(id)?.online) peers.add(id);
      if (peers.size === MAX_PROBE_PEERS) break;
    }
    // One silent peer can be a fault on its own device.
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
    const wasOnline = this.status === "online";
    this.status = status;
    if (status !== "online") {
      const reconnecting = status === "waiting" || status === "connecting";
      if (wasOnline || !reconnecting) {
        this.interruptRequests(
          status === "stopped" ? "left the room" : "the connection to the room was lost",
          reconnecting ? "local-reconnected" : undefined,
        );
      }
      if (wasOnline) this.resetQueues();
      this.deps.onDisconnect?.();
      // Out of the room: none of the others is reachable until it is back.
      for (const peer of this.peers.values()) peer.online = false;
      this.cancelQueuedReads();
    }
    this.changed();
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.t === "presence") {
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
        if (peer.online && !next.get(peer.id)?.online) this.deps.onDisconnect?.(peer.id);
      }
      const previous = this.peers;
      this.peers = next;
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
      if (code === "no-such-device" && !p.retried && RETRYABLE_READS.has(p.message.method)) {
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
    if (limited && reply && performance.now() - reply.sentAt < REQUEST_TIMEOUT_MS) {
      this.rejectReply(reply.from, reply.epoch, reply, RATE_LIMITED);
    }
  }

  /**
   * Opens a message, and hands it on when it was sealed for this device and
   * this epoch, and not taken before. Messages are taken in the order they
   * came; what they ask is served apart, so one that waits holds up none.
   */
  private async take(frame: Delivered, inbox: RemoteRoom["inbox"]): Promise<void> {
    if (inbox !== this.inbox || this.status !== "online") return;
    // Sent to another device of the account, and passed on here: not for this one.
    if (frame.to !== this.deps.self.id && frame.to !== ALL_DEVICES) return;
    // Sealed with a pairing code's key: the pairing opens it, if one is under way.
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
    // The relay vouches for who sent it; a hello for another device is not taken.
    if (hello && hello.device.id !== frame.from) return;
    if (frame.to === ALL_DEVICES || envelope.peer !== this.epoch) {
      // Answer hellos as before. A directed request with an old receiver epoch
      // can also prompt an introduction, but its contents are never served.
      if (hello) void this.post(frame.from, envelope.epoch, this.hello(true));
      else if (frame.to === this.deps.self.id && "method" in message && "id" in message) {
        const method = isRpcMethod(message.method) ? message.method : "unknown";
        this.warnOccasionally(
          "stale-epoch",
          `Dropped request for stale epoch method=${method} peer=${frame.from.slice(0, 8)}`,
        );
        if (!this.past.has(`${frame.from}|${envelope.epoch}`)) {
          this.retryHello(frame.from, envelope.epoch);
        }
      }
      return;
    }
    if (!this.fresh(frame.from, envelope.epoch, frame.seq)) return;
    void this.handle(frame.from, envelope.epoch, message, this.epoch).catch(() => {
      this.warnOccasionally("relay-error", "Could not handle a remote room message");
    });
  }

  /**
   * Whether a message of the sender's epoch with this seq is one not taken
   * yet; it takes note of it. Once a sender's newer epoch is heard, none of
   * an older one is taken.
   */
  private fresh(from: string, epoch: string, seq: number): boolean {
    const heard = this.heard.get(from);
    if (heard?.epoch === epoch) {
      if (seq <= heard.seq) return false;
    } else {
      if (this.past.has(`${from}|${epoch}`)) return false;
      if (heard) this.past.add(`${from}|${heard.epoch}`);
    }
    this.heard.set(from, { epoch, seq });
    if (this.past.size > MAX_PAST_EPOCHS) {
      // Too many to keep: a new epoch of its own, which nothing sealed before names.
      this.renew("the room started over");
      void this.post(ALL_DEVICES, null, this.hello(true));
      return false;
    }
    if (heard && heard.epoch !== epoch) this.rejoined(from, epoch);
    return true;
  }

  /**
   * Another device heard in a new epoch while this one stayed: it joined the
   * room again with a new connection, which the room may never have shown
   * as gone (its old socket held on). Going, it dropped what was watched
   * there, which is asked for again as its `rejoins` grows.
   */
  private rejoined(from: string, epoch: string): void {
    for (const p of this.pending.values()) {
      if (p.to === from && p.attempt && p.attempt.peer !== epoch) {
        this.interruptRequest(p, "the device reconnected to the room", "peer-rejoined");
      }
    }
    this.deps.onDisconnect?.(from);
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

  /** A message taken: from `from`, in its epoch `epoch`, which an answer goes in. */
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
      if (this.peers.get(from)?.online === true) this.resumeRequests(from, epoch);
      return;
    }
    if ("method" in message && "id" in message) {
      const current = () =>
        this.status === "online" &&
        this.epoch === localEpoch &&
        this.heard.get(from)?.epoch === epoch &&
        this.peers.get(from)?.online === true;
      if (message.method === "files.read") {
        const budget = readsWholeImage(message.params) ? this.imageReadBudget : this.fileReadBudget;
        if (!current()) return;
        if (!(await budget.acquire(current))) {
          // Every refused request is told, each with its own small reply: left
          // unanswered it would wait out the whole request timeout.
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
          const answer = await this.answer(from, message.method, message.params, current);
          if (current()) await this.reply(from, epoch, message, answer, current);
        } finally {
          budget.release();
        }
        return;
      }
      const transfer = isFileTransferMethod(message.method);
      if (transfer && !current()) return;
      const answer = await this.answer(
        from,
        message.method,
        message.params,
        transfer ? current : undefined,
      );
      if (current()) await this.reply(from, epoch, message, answer, current);
      return;
    }
    if ("method" in message) {
      const method = message.method;
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

  private async answer(
    from: string,
    method: string,
    params: unknown,
    isCurrent?: () => boolean,
  ): Promise<{ result: unknown } | { error: RpcError }> {
    if (!isRpcMethod(method)) {
      return { error: { code: RpcErrorCode.MethodNotFound, message: `no method ${method}` } };
    }
    const spec = RPC_METHODS[method];
    const parsed = spec.params.safeParse(params ?? {});
    // An agent's request (`from`) is taken as the user lets agents act here, not as people may;
    // `from` is looked for as it came, since a method whose params have none drops it.
    const byAgent =
      typeof params === "object" &&
      params !== null &&
      (params as { from?: unknown }).from !== undefined;
    if (byAgent && parsed.success && (parsed.data as { from?: unknown }).from === undefined) {
      // Answering the user's consent prompts, say: that is the user's, not an agent's.
      return {
        error: { code: RpcErrorCode.Forbidden, message: `${method} is not taken from agents` },
      };
    }
    // A phone runs no agents: a request of one from it is not one.
    if (byAgent && PHONE_PLATFORMS.has(this.peers.get(from)?.platform ?? "")) {
      return {
        error: {
          code: RpcErrorCode.Forbidden,
          message: "agents' requests are not taken from a phone",
        },
      };
    }
    // An agent may do only what people may do from other devices here, and only when agents may.
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
    if (!serves.includes(capability as Capability)) {
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
      return { error: { code: RpcErrorCode.InvalidParams, message: parsed.error.message } };
    }
    const started = performance.now();
    const slow = setTimeout(() => {
      const elapsed = Math.round(performance.now() - started);
      this.warnOccasionally(
        "slow-serving",
        `Still serving remote request method=${method} peer=${from.slice(0, 8)} elapsedMs=${elapsed}`,
      );
    }, REQUEST_TIMEOUT_MS);
    slow.unref?.();
    try {
      return {
        result: await this.deps.serve({
          from,
          method,
          params: parsed.data,
          ...(isCurrent ? { isCurrent } : {}),
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
  }
}
