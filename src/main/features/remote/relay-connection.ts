import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  type ClientFrame,
  MAX_FRAME_BYTES,
  type ServerFrame,
  ServerFrameSchema,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { OutdatedError, ServerError, SignedOutError } from "./errors";
import { responsiveTimeout } from "./frame-stall";
import { retryAfterSeconds, SocketRetryAfter } from "./retry-after";

const log = createLogger("remote-relay");

export const CLOSE_REPLACED = 4000;
export const CLOSE_SIGNED_OUT = 4001;
export const CLOSE_FLOODING = 4002;
const FLOOD_RETRY_INITIAL_MS = 60_000;
const FLOOD_RETRY_MAX_MS = 15 * 60_000;
const FLOOD_RETRY_RESET_MS = 10 * 60_000;

export const QUICK_RETRY_EVERY_MS = 30_000;

export const MAX_DELIVERED_CHARS = MAX_FRAME_BYTES + 1024;

export const RELAY_PING = '{"t":"ping"}';
export const RELAY_PONG = '{"t":"pong"}';

export const HEARTBEAT_EVERY_MS = 25_000;
export const PONG_WAIT_MS = 10_000;
export const WAKE_PONG_WAIT_MS = 2_500;
const MAX_MISSED_PONGS = 2;
export const SEND_BUFFER_STALL_MS = 8_000;
export const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const SEND_BUFFER_CHECK_MS = 1_000;
const RECOVERY_LOG_INTERVAL_MS = 30_000;
export type RelayRecoveryReason =
  | "pong-timeout"
  | "send-failed"
  | "send-buffer-stalled"
  | "inbox-stalled"
  | "outbox-stalled"
  | "peer-probes-unanswered";
type RelayWarning = RelayRecoveryReason | "open-timeout" | `pong-miss-${number}`;
export type RelayStopReason = "user" | "room-changed" | "pairing-ended" | "shutdown";
type LocalCloseReason =
  | RelayRecoveryReason
  | RelayStopReason
  | "open-timeout"
  | "route-change"
  | "upgrade-refused"
  | "superseded";
type ConnectReason =
  | RelayRecoveryReason
  | "open-timeout"
  | "start"
  | "route-change"
  | "socket-closed"
  | "rate-limited"
  | "ticket-failed"
  | "flooding";
const SERVER_CLOSE_REASONS: ReadonlyMap<number, string> = new Map([
  [CLOSE_REPLACED, "replaced"],
  [CLOSE_SIGNED_OUT, "signed-out"],
  [CLOSE_FLOODING, "flooding"],
]);

export type RelayStatus = "connecting" | "online" | "waiting" | "replaced" | "outdated" | "stopped";

type Socket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  readonly bufferedAmount?: number;
  addEventListener: WebSocket["addEventListener"];
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: UpgradeRefusal) => void,
  ): void;
};

type UpgradeRefusal = Pick<IncomingMessage, "statusCode" | "headers" | "destroy">;

export interface RelayConnectionDeps {
  url(signal: AbortSignal): Promise<string>;
  onOpen(): void;
  onFrame(frame: ServerFrame): void;
  onStatus(status: RelayStatus): void;
  onSignedOut(): void;
  unreachable?(url: string): void;
  failed?(code: string, status?: number): void;
  socket?: (url: string) => Socket;
  retryAfter?: SocketRetryAfter;
  backoff?: (attempt: number) => number;
  now?: () => number;
  heartbeat?: { every: number; wait: number };
}

interface ActiveSocket {
  readonly socket: Socket;
  readonly origin: string;
  openedAt: number;
}

export function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class RelayConnection {
  private connection: ActiveSocket | null = null;
  private owner: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private floodBackoffMs = 0;
  private running = false;
  private status: RelayStatus = "stopped";
  private quickAt = Number.NEGATIVE_INFINITY;
  private beat: ReturnType<typeof setInterval> | null = null;
  private cancelPong: (() => void) | null = null;
  private missedPongs = 0;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private writeBuffer: {
    amount: number;
    progressedAt: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  private readonly warnedAt = new Map<RelayWarning, number>();
  private invalidErrorAt = -Infinity;
  private readonly retryAfter: SocketRetryAfter;

  constructor(private readonly deps: RelayConnectionDeps) {
    this.retryAfter = deps.retryAfter ?? new SocketRetryAfter();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.floodBackoffMs = 0;
    void this.connect("start");
  }

  stop(reason: RelayStopReason = "user"): void {
    this.running = false;
    this.clearTimer();
    this.drop(reason);
    this.set("stopped");
  }

  reconnect(): void {
    if (!this.running) return;
    this.clearTimer();
    this.drop("route-change");
    this.attempt = 0;
    void this.connect("route-change");
  }

  wake(): void {
    const connection = this.writable();
    if (!connection) return;
    this.clearPongTimer();
    this.ping(connection, WAKE_PONG_WAIT_MS, () => {
      this.ping(connection, WAKE_PONG_WAIT_MS, () => this.recover("pong-timeout"));
    });
  }

  recover(reason: RelayRecoveryReason): void {
    const { connection, owner } = this;
    if (!connection || !owner || this.status !== "online") return;
    this.deps.failed?.(reason);
    this.closeCurrent(connection, reason);
    if (this.quickRetry()) void this.connect(reason);
    else this.retry(owner, reason);
  }

  send(frame: ClientFrame): boolean {
    const connection = this.connection;
    if (this.status !== "online" || !connection) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return false;
    return this.sendText(connection, text);
  }

  get bufferedAmount(): number {
    return this.connection?.socket.bufferedAmount ?? 0;
  }

  onlineRoute(): { readonly origin: string; readonly openedAt: number } | null {
    return this.writable();
  }

  private writable(): ActiveSocket | null {
    const connection = this.connection;
    return this.status === "online" && connection?.socket.readyState === 1 ? connection : null;
  }

  healthy(): void {
    this.attempt = 0;
  }

  private sendText(connection: ActiveSocket, text: string): boolean {
    const { socket } = connection;
    this.observeWriteBuffer(connection);
    if (this.connection !== connection) return false;
    try {
      if (socket.readyState !== 1) throw new Error("relay socket is closed");
      socket.send(text);
    } catch {
      this.warnRecovery("send-failed");
      this.recover("send-failed");
      return false;
    }
    if (this.connection === connection) this.observeWriteBuffer(connection);
    return true;
  }

  private observeWriteBuffer(connection: ActiveSocket): void {
    const amount = connection.socket.bufferedAmount ?? 0;
    if (amount === 0) {
      this.stopWriteMonitor();
      return;
    }
    const now = performance.now();
    const buffer = this.writeBuffer;
    if (!buffer) {
      const timer = setInterval(() => {
        if (this.connection === connection) this.observeWriteBuffer(connection);
      }, SEND_BUFFER_CHECK_MS);
      timer.unref?.();
      this.writeBuffer = { amount, progressedAt: now, timer };
      return;
    }
    if (amount < buffer.amount) buffer.progressedAt = now;
    buffer.amount = amount;
    const elapsed = now - buffer.progressedAt;
    if (elapsed >= SEND_BUFFER_STALL_MS) {
      this.warnRecovery("send-buffer-stalled", elapsed);
      this.recover("send-buffer-stalled");
    }
  }

  private stopWriteMonitor(): void {
    if (this.writeBuffer) clearInterval(this.writeBuffer.timer);
    this.writeBuffer = null;
  }

  private warnOccasionally(key: RelayWarning, message: string): void {
    const now = performance.now();
    if (now - (this.warnedAt.get(key) ?? -Infinity) < RECOVERY_LOG_INTERVAL_MS) return;
    this.warnedAt.set(key, now);
    log.warn(message);
  }

  private warnRecovery(reason: RelayRecoveryReason | "open-timeout", elapsed = 0): void {
    this.warnOccasionally(
      reason,
      `Relay reconnect reason=${reason} elapsedMs=${Math.round(elapsed)} bufferedBytes=${this.bufferedAmount}`,
    );
  }

  private async connect(reason: ConnectReason): Promise<void> {
    if (!this.running) return;
    this.clearTimer();
    const owner = new AbortController();
    this.owner = owner;
    if (this.waitIfLimited(owner, reason)) return;
    this.set("connecting");
    if (!this.owns(owner)) return;
    log.info(`Relay connecting reason=${reason}`);

    let url: string;
    let connection: ActiveSocket;
    try {
      url = await this.deps.url(owner.signal);
      if (!this.owns(owner)) return;
      if (this.waitIfLimited(owner, reason)) return;
      const origin = new URL(url).origin;
      const socket = this.deps.socket?.(url) ?? new WebSocket(url, { perMessageDeflate: false });
      if (!this.owns(owner)) {
        this.closeSocket(socket, "superseded");
        return;
      }
      connection = { origin, socket, openedAt: Infinity };
    } catch (error) {
      if (!this.owns(owner)) return;
      if (error instanceof SignedOutError) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else if (error instanceof OutdatedError) {
        this.deps.failed?.("outdated");
        this.giveUp("outdated");
      } else if (error instanceof ServerError && error.status === 429) {
        this.deps.failed?.("rate-limited", 429);
        this.retryAfter.pause(error.retryAfter ?? 0);
        this.retry(owner, "rate-limited");
      } else {
        this.deps.failed?.(
          "ticket-failed",
          error instanceof ServerError ? error.status : undefined,
        );
        this.retry(owner, "ticket-failed");
      }
      return;
    }

    const { socket } = connection;
    this.connection = connection;
    const started = performance.now();
    this.openTimer = setTimeout(() => {
      if (this.connection !== connection) return;
      this.warnRecovery("open-timeout", performance.now() - started);
      this.deps.failed?.("open-timeout");
      this.closeCurrent(connection, "open-timeout");
      this.deps.unreachable?.(url);
      this.retry(owner, "open-timeout");
    }, SOCKET_OPEN_TIMEOUT_MS);
    this.openTimer.unref?.();
    socket.on("unexpected-response", (_request, response) => {
      if (this.connection === connection && response.statusCode === 429) {
        this.deps.failed?.("rate-limited", 429);
        this.retryAfter.pause(retryAfterSeconds(response.headers["retry-after"]) ?? 0);
        this.closeCurrent(connection, "upgrade-refused");
        this.retry(owner, "rate-limited");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      response.destroy();
    });
    socket.addEventListener("open", () => {
      if (this.connection !== connection) return;
      connection.openedAt = performance.now();
      this.clearOpenTimer();
      log.debug(
        `Relay socket opened elapsedMs=${Math.round(connection.openedAt - started)} reason=${reason}`,
      );
      this.set("online");
      if (this.connection !== connection) return;
      this.startHeartbeat(connection);
      this.deps.onOpen();
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (this.connection !== connection) return;
      if (event.data === RELAY_PONG) {
        this.missedPongs = 0;
        this.clearPongTimer();
        return;
      }
      if (typeof event.data !== "string") return;
      if (event.data.length > MAX_DELIVERED_CHARS) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        return;
      }
      const data = decoded;
      const isError =
        data !== null && typeof data === "object" && "t" in data && data.t === "error";
      const candidate = isError && !("message" in data) ? { ...data, message: "" } : data;
      const parsed = ServerFrameSchema.safeParse(candidate);
      if (parsed.success) {
        this.deps.onFrame(parsed.data);
      } else if (isError) {
        const now = performance.now();
        if (now - this.invalidErrorAt >= RECOVERY_LOG_INTERVAL_MS) {
          this.invalidErrorAt = now;
          log.warn("Relay error frame did not match the expected format");
        }
      }
    });
    socket.addEventListener("close", (event: { code: number }) => {
      if (this.connection !== connection) return;
      const opened = Number.isFinite(connection.openedAt);
      const reason = SERVER_CLOSE_REASONS.get(event.code) ?? "socket-closed";
      log.info(`Relay socket closed code=${event.code} opened=${opened} reason=${reason}`);
      this.connection = null;
      this.stopHeartbeat();
      this.clearOpenTimer();
      this.stopWriteMonitor();
      if (performance.now() - connection.openedAt >= FLOOD_RETRY_RESET_MS) {
        this.floodBackoffMs = 0;
      }
      if (event.code === CLOSE_REPLACED) this.giveUp("replaced");
      else if (event.code === CLOSE_SIGNED_OUT) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else if (event.code === CLOSE_FLOODING) {
        this.deps.failed?.("flooding");
        this.floodBackoffMs = Math.min(
          FLOOD_RETRY_MAX_MS,
          Math.max(FLOOD_RETRY_INITIAL_MS, this.floodBackoffMs * 2),
        );
        log.warn(
          `Relay closed a flooding connection code=${CLOSE_FLOODING} retryMs=${this.floodBackoffMs}`,
        );
        this.retry(owner, "flooding", this.floodBackoffMs);
      } else {
        this.deps.failed?.(opened ? "socket-closed" : "open-failed");
        if (opened && this.quickRetry()) void this.connect("socket-closed");
        else {
          if (!opened) this.deps.unreachable?.(url);
          this.retry(owner, "socket-closed");
        }
      }
    });
    socket.addEventListener("error", () => {});
  }

  private startHeartbeat(connection: ActiveSocket): void {
    this.stopHeartbeat();
    const { every, wait } = this.deps.heartbeat ?? {
      every: HEARTBEAT_EVERY_MS,
      wait: PONG_WAIT_MS,
    };
    this.beat = setInterval(() => {
      if (this.cancelPong) return;
      this.ping(connection, wait, (elapsed) => {
        const misses = ++this.missedPongs;
        const reconnect = misses >= MAX_MISSED_PONGS;
        this.warnOccasionally(
          `pong-miss-${misses}`,
          `Relay heartbeat missed reason=pong-timeout elapsedMs=${Math.round(elapsed)} consecutive=${misses} reconnect=${reconnect}`,
        );
        if (reconnect) this.recover("pong-timeout");
      });
    }, every);
  }

  private ping(connection: ActiveSocket, wait: number, missed: (elapsed: number) => void): void {
    if (this.connection !== connection || !this.sendText(connection, RELAY_PING)) return;
    if (this.connection !== connection) return;
    this.cancelPong = responsiveTimeout(wait, (elapsed) => {
      this.cancelPong = null;
      if (this.connection === connection) missed(elapsed);
    });
  }

  private stopHeartbeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.missedPongs = 0;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    this.cancelPong?.();
    this.cancelPong = null;
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  private quickRetry(): boolean {
    if (!this.running) return false;
    const now = (this.deps.now ?? Date.now)();
    if (now - this.quickAt < QUICK_RETRY_EVERY_MS) return false;
    this.quickAt = now;
    return true;
  }

  private waitIfLimited(owner: AbortController, reason: ConnectReason): boolean {
    const remaining = this.retryAfter.remaining();
    if (remaining <= 0) return false;
    this.schedule(owner, reason, remaining);
    return true;
  }

  private retry(owner: AbortController, reason: ConnectReason, floodDelay?: number): void {
    if (!this.owns(owner)) return;
    const backoff = floodDelay ?? (this.deps.backoff ?? defaultBackoff)(this.attempt++);
    this.schedule(owner, reason, Math.max(backoff, this.retryAfter.remaining()));
  }

  private schedule(owner: AbortController, reason: ConnectReason, delay: number): void {
    if (!this.owns(owner)) return;
    this.set("waiting");
    if (!this.owns(owner)) return;
    log.info(`Relay retry scheduled reason=${reason} delayMs=${delay}`);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.owns(owner)) void this.connect(reason);
    }, Math.ceil(delay));
  }

  private giveUp(status: RelayStatus): void {
    this.running = false;
    this.clearTimer();
    this.drop();
    this.set(status);
  }

  private drop(reason: LocalCloseReason = "user"): void {
    const owner = this.owner;
    this.owner = null;
    if (this.connection) this.closeCurrent(this.connection, reason);
    owner?.abort();
  }

  private closeCurrent({ socket }: ActiveSocket, reason: LocalCloseReason): void {
    this.connection = null;
    this.stopHeartbeat();
    this.clearOpenTimer();
    this.stopWriteMonitor();
    this.closeSocket(socket, reason);
  }

  private closeSocket(socket: Socket, reason: LocalCloseReason): void {
    if (socket.readyState > 1) return;
    log.info(`Relay closing socket code=1000 reason=${reason}`);
    try {
      socket.close(1000, reason);
    } catch {}
  }

  private owns(owner: AbortController): boolean {
    return this.running && this.owner === owner;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(status: RelayStatus): void {
    if (status === this.status) return;
    log.info(`Relay state changed from=${this.status} to=${status}`);
    this.status = status;
    this.deps.onStatus(status);
  }
}
