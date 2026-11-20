/**
 * This device's socket to its account's room on the relay: connected with
 * a one-time ticket, kept up with backoff, and given up when the relay says
 * so: replaced by another connection of this device (4000), whose
 * reconnecting would push this one off in turn, or signed out (4001); or
 * when the ticket says the app is too old for the server (OutdatedError).
 * A heartbeat finds a socket that no longer reaches the relay and joins
 * the room again.
 */
import {
  type ClientFrame,
  MAX_FRAME_BYTES,
  type ServerFrame,
  ServerFrameSchema,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { OutdatedError, SignedOutError } from "./errors";

const log = createLogger("remote-relay");

/** Another connection of this device took its place in the room. */
export const CLOSE_REPLACED = 4000;
/** The device's sign-in ended: signed out, removed, or expired. */
export const CLOSE_SIGNED_OUT = 4001;
/** The relay closed a socket that exhausted its frame budget. */
export const CLOSE_FLOODING = 4002;
const FLOOD_RETRY_INITIAL_MS = 60_000;
const FLOOD_RETRY_MAX_MS = 15 * 60_000;
const FLOOD_RETRY_RESET_MS = 10 * 60_000;

/**
 * How often a connection that was in the room tries again at once when it
 * is lost: the relay restarting the room (a deploy) drops every socket at
 * once, and coming back within a second keeps it out of sight. Lost again
 * sooner, it waits as any other loss does.
 */
export const QUICK_RETRY_EVERY_MS = 30_000;

/**
 * Most characters a frame from the relay may take: the most a device may
 * send, and the sender's id the relay adds. A longer one is not read.
 */
export const MAX_DELIVERED_CHARS = MAX_FRAME_BYTES + 1024;

/** A heartbeat, and the relay's answer to it: the runtime's own, which does not wake the room. */
export const RELAY_PING = '{"t":"ping"}';
export const RELAY_PONG = '{"t":"pong"}';

/**
 * How often an open socket is asked whether it still reaches the relay. A
 * socket whose way there broke (the computer slept, or went to another
 * network) says nothing until something is sent on it, and stays "online"
 * while what is sent on it goes nowhere; and a connection quiet for long
 * may be cut on the way.
 */
export const HEARTBEAT_EVERY_MS = 25_000;
/** How long an answer is waited for before the socket is taken for lost. */
export const PONG_WAIT_MS = 10_000;
export const SEND_BUFFER_STALL_MS = 8_000;
export const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const SEND_BUFFER_CHECK_MS = 1_000;
const RECOVERY_LOG_INTERVAL_MS = 30_000;
type RecoveryReason = "pong-timeout" | "send-failed" | "send-buffer-stalled" | "open-timeout";

/**
 * - connecting: asking for a ticket, or opening the socket;
 * - online: in the room;
 * - waiting: lost, trying again after a while;
 * - replaced: another connection of this device took its place: not tried again;
 * - outdated: the server no longer takes this app's version: not tried again;
 * - stopped: closed here.
 */
export type RelayStatus = "connecting" | "online" | "waiting" | "replaced" | "outdated" | "stopped";

type Socket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  readonly bufferedAmount?: number;
  addEventListener(type: string, listener: (event: never) => void): void;
};

export interface RelayConnectionDeps {
  /**
   * The socket's address, with a fresh ticket: ws(s)://server/relay?v=2&ticket=...
   * SignedOutError and OutdatedError give up; any other failure tries again.
   * The signal is aborted if this attempt is replaced or stopped.
   */
  url(signal: AbortSignal): Promise<string>;
  onOpen(): void;
  onFrame(frame: ServerFrame): void;
  onStatus(status: RelayStatus): void;
  /** The relay or the server says the sign-in ended. */
  onSignedOut(): void;
  /** The socket to `url` closed before it opened: what it went to was not reached. */
  unreachable?(url: string): void;
  socket?: (url: string) => Socket;
  /** How long to wait before the `attempt`th try again, in ms. */
  backoff?: (attempt: number) => number;
  now?: () => number;
  /** HEARTBEAT_EVERY_MS and PONG_WAIT_MS, unless given. */
  heartbeat?: { every: number; wait: number };
}

/** A socket and the origin it reached, stable for the life of this connection. */
interface ActiveSocket {
  readonly socket: Socket;
  readonly origin: string;
}

/** 1 s doubling to 30 s, give or take a fifth, so devices do not come back all at once. */
export function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Owns the current relay attempt from ticket acquisition through socket close. */
export class RelayConnection {
  private connection: ActiveSocket | null = null;
  /** The controller identifies the current attempt even before a socket exists. */
  private owner: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private floodBackoffMs = 0;
  private running = false;
  private status: RelayStatus = "stopped";
  /** When a lost connection last tried again at once. */
  private quickAt = Number.NEGATIVE_INFINITY;
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Running while a heartbeat waits for the relay to answer. */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private writeBuffer: {
    amount: number;
    progressedAt: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  private readonly warnedAt = new Map<RecoveryReason, number>();
  private invalidErrorAt = -Infinity;

  constructor(private readonly deps: RelayConnectionDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.floodBackoffMs = 0;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.drop();
    this.set("stopped");
  }

  /** Opens a new socket now in place of this one, as to go another way; nothing when stopped. */
  reconnect(): void {
    if (!this.running) return;
    this.clearTimer();
    this.drop();
    this.attempt = 0;
    void this.connect();
  }

  /** Reopens a stalled connection with the same backoff as other socket losses. */
  recover(): void {
    const { connection, owner } = this;
    if (!connection || !owner || this.status !== "online") return;
    this.closeCurrent(connection);
    if (this.quickRetry()) void this.connect();
    else this.retry(owner);
  }

  /** Sends a frame while online; false when it cannot go (offline, or too big). */
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

  /** The route of the actual open socket, with identity stable across probes. */
  onlineRoute(): { readonly origin: string } | null {
    const connection = this.connection;
    return this.status === "online" && connection?.socket.readyState === 1 ? connection : null;
  }

  /** Presence resets ordinary retries. Flooding history needs a sustained connection. */
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
      this.recover();
      return false;
    }
    if (this.connection === connection) this.observeWriteBuffer(connection);
    return true;
  }

  /** Checks drain progress independently of incoming frames and heartbeat responses. */
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
      this.recover();
    }
  }

  private stopWriteMonitor(): void {
    if (this.writeBuffer) clearInterval(this.writeBuffer.timer);
    this.writeBuffer = null;
  }

  private warnRecovery(reason: RecoveryReason, elapsed = 0): void {
    const now = performance.now();
    if (now - (this.warnedAt.get(reason) ?? -Infinity) < RECOVERY_LOG_INTERVAL_MS) return;
    this.warnedAt.set(reason, now);
    log.warn(
      `Relay reconnect reason=${reason} elapsedMs=${Math.round(elapsed)} bufferedBytes=${this.bufferedAmount}`,
    );
  }

  /** Gets a ticket and opens a socket only while this attempt owns the relay. */
  private async connect(): Promise<void> {
    if (!this.running) return;
    const owner = new AbortController();
    this.owner = owner;
    this.set("connecting");
    if (!this.owns(owner)) return;

    let url: string;
    let connection: ActiveSocket;
    try {
      url = await this.deps.url(owner.signal);
      if (!this.owns(owner)) return;
      const origin = new URL(url).origin;
      const socket = (this.deps.socket ?? ((address) => new WebSocket(address) as Socket))(url);
      if (!this.owns(owner)) {
        if (socket.readyState <= 1) socket.close(1000, "bye");
        return;
      }
      connection = { origin, socket };
    } catch (error) {
      if (!this.owns(owner)) return;
      if (error instanceof SignedOutError) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else if (error instanceof OutdatedError) this.giveUp("outdated");
      else this.retry(owner);
      return;
    }

    const { socket } = connection;
    this.connection = connection;
    let openedAt: number | undefined;
    const started = performance.now();
    this.openTimer = setTimeout(() => {
      if (this.connection !== connection) return;
      this.warnRecovery("open-timeout", performance.now() - started);
      this.closeCurrent(connection);
      this.deps.unreachable?.(url);
      this.retry(owner);
    }, SOCKET_OPEN_TIMEOUT_MS);
    this.openTimer.unref?.();
    socket.addEventListener("open", () => {
      if (this.connection !== connection) return;
      openedAt = performance.now();
      this.clearOpenTimer();
      log.debug(`Relay socket opened elapsedMs=${Math.round(openedAt - started)}`);
      this.set("online");
      if (this.connection !== connection) return;
      this.startHeartbeat(connection);
      this.deps.onOpen();
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (this.connection !== connection) return;
      if (event.data === RELAY_PONG) {
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
      // Some relay errors carry only a code and an optional seq.
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
      const opened = openedAt !== undefined;
      log.info(`Relay socket closed code=${event.code} opened=${opened}`);
      this.connection = null;
      this.stopHeartbeat();
      this.clearOpenTimer();
      this.stopWriteMonitor();
      if (openedAt !== undefined && performance.now() - openedAt >= FLOOD_RETRY_RESET_MS) {
        this.floodBackoffMs = 0;
      }
      if (event.code === CLOSE_REPLACED) this.giveUp("replaced");
      else if (event.code === CLOSE_SIGNED_OUT) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else if (event.code === CLOSE_FLOODING) {
        this.floodBackoffMs = Math.min(
          FLOOD_RETRY_MAX_MS,
          Math.max(FLOOD_RETRY_INITIAL_MS, this.floodBackoffMs * 2),
        );
        log.warn(
          `Relay closed a flooding connection code=${CLOSE_FLOODING} retryMs=${this.floodBackoffMs}`,
        );
        this.retry(owner, this.floodBackoffMs);
      } else if (opened && this.quickRetry()) {
        void this.connect();
      } else {
        if (!opened) this.deps.unreachable?.(url);
        this.retry(owner);
      }
    });
    // An error is followed by a close, which decides what comes next.
    socket.addEventListener("error", () => {});
  }

  /**
   * Sends the relay a heartbeat now and then while `socket` is open; one
   * not answered in time lets the socket go and joins the room again, as a
   * socket that closed does. Its own close may come long after, or never.
   */
  private startHeartbeat(connection: ActiveSocket): void {
    this.stopHeartbeat();
    const { every, wait } = this.deps.heartbeat ?? {
      every: HEARTBEAT_EVERY_MS,
      wait: PONG_WAIT_MS,
    };
    this.beat = setInterval(() => {
      if (this.connection !== connection || this.pongTimer) return;
      if (!this.sendText(connection, RELAY_PING) || this.connection !== connection) return;
      const started = performance.now();
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.connection !== connection) return;
        this.warnRecovery("pong-timeout", performance.now() - started);
        this.recover();
      }, wait);
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  /** Whether a connection lost from the room may try again at once (QUICK_RETRY_EVERY_MS). */
  private quickRetry(): boolean {
    if (!this.running) return false;
    const now = (this.deps.now ?? Date.now)();
    if (now - this.quickAt < QUICK_RETRY_EVERY_MS) return false;
    this.quickAt = now;
    return true;
  }

  /** Schedules backoff only for the attempt that reported the loss. */
  private retry(owner: AbortController, floodDelay?: number): void {
    if (!this.owns(owner)) return;
    this.set("waiting");
    if (!this.owns(owner)) return;
    const delay = floodDelay ?? (this.deps.backoff ?? defaultBackoff)(this.attempt++);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.owns(owner)) void this.connect();
    }, delay);
  }

  private giveUp(status: RelayStatus): void {
    this.running = false;
    this.clearTimer();
    this.drop();
    this.set(status);
  }

  /** Invalidates the attempt and detaches its socket before closing it. */
  private drop(): void {
    const owner = this.owner;
    this.owner = null;
    if (this.connection) this.closeCurrent(this.connection);
    owner?.abort();
  }

  private closeCurrent({ socket }: ActiveSocket): void {
    this.connection = null;
    this.stopHeartbeat();
    this.clearOpenTimer();
    this.stopWriteMonitor();
    try {
      if (socket.readyState <= 1) socket.close(1000, "bye");
    } catch {
      // The socket may have closed while being detached.
    }
  }

  /** Whether pending work still belongs to the active relay attempt. */
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
