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
import { OutdatedError, SignedOutError } from "./errors";

/** Another connection of this device took its place in the room. */
export const CLOSE_REPLACED = 4000;
/** The device's sign-in ended: signed out, removed, or expired. */
export const CLOSE_SIGNED_OUT = 4001;

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
  private running = false;
  private status: RelayStatus = "stopped";
  /** When a lost connection last tried again at once. */
  private quickAt = Number.NEGATIVE_INFINITY;
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Running while a heartbeat waits for the relay to answer. */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RelayConnectionDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
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

  /** Sends a frame while online; false when it cannot go (offline, or too big). */
  send(frame: ClientFrame): boolean {
    const socket = this.connection?.socket;
    if (this.status !== "online" || !socket) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return false;
    socket.send(text);
    return true;
  }

  get bufferedAmount(): number {
    return this.connection?.socket.bufferedAmount ?? 0;
  }

  /** The route of the actual open socket, with identity stable across probes. */
  onlineRoute(): { readonly origin: string } | null {
    const connection = this.connection;
    return this.status === "online" && connection?.socket.readyState === 1 ? connection : null;
  }

  /** The room answered: the connection is good, and the next loss starts the backoff over. */
  healthy(): void {
    this.attempt = 0;
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
    let opened = false;
    socket.addEventListener("open", () => {
      if (this.connection !== connection) return;
      opened = true;
      this.set("online");
      if (this.connection !== connection) return;
      this.startHeartbeat(connection, owner);
      this.deps.onOpen();
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (this.connection !== connection) return;
      // Anything from the relay answers the heartbeat.
      this.clearPongTimer();
      if (typeof event.data !== "string" || event.data === RELAY_PONG) return;
      if (event.data.length > MAX_DELIVERED_CHARS) return;
      let parsed: ReturnType<typeof ServerFrameSchema.safeParse>;
      try {
        parsed = ServerFrameSchema.safeParse(JSON.parse(event.data));
      } catch {
        return;
      }
      if (parsed.success) this.deps.onFrame(parsed.data);
    });
    socket.addEventListener("close", (event: { code: number }) => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.stopHeartbeat();
      if (event.code === CLOSE_REPLACED) this.giveUp("replaced");
      else if (event.code === CLOSE_SIGNED_OUT) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
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
  private startHeartbeat(connection: ActiveSocket, owner: AbortController): void {
    const { socket } = connection;
    this.stopHeartbeat();
    const { every, wait } = this.deps.heartbeat ?? {
      every: HEARTBEAT_EVERY_MS,
      wait: PONG_WAIT_MS,
    };
    this.beat = setInterval(() => {
      if (this.connection !== connection || this.pongTimer) return;
      try {
        socket.send(RELAY_PING);
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.connection !== connection) return;
        this.connection = null;
        this.stopHeartbeat();
        try {
          socket.close();
        } catch {
          // Closing already.
        }
        if (this.quickRetry()) void this.connect();
        else this.retry(owner);
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

  /** Whether a connection lost from the room may try again at once (QUICK_RETRY_EVERY_MS). */
  private quickRetry(): boolean {
    if (!this.running) return false;
    const now = (this.deps.now ?? Date.now)();
    if (now - this.quickAt < QUICK_RETRY_EVERY_MS) return false;
    this.quickAt = now;
    return true;
  }

  /** Schedules backoff only for the attempt that reported the loss. */
  private retry(owner: AbortController): void {
    if (!this.owns(owner)) return;
    this.set("waiting");
    if (!this.owns(owner)) return;
    const delay = (this.deps.backoff ?? defaultBackoff)(this.attempt);
    this.attempt += 1;
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
    const socket = this.connection?.socket;
    this.owner = null;
    this.connection = null;
    this.stopHeartbeat();
    owner?.abort();
    if (socket && socket.readyState <= 1) socket.close(1000, "bye");
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
    this.status = status;
    this.deps.onStatus(status);
  }
}
