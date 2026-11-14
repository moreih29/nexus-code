/**
 * This device's socket to its account's room on the relay: connected with
 * a one-time ticket, kept up with backoff, and given up when the relay says
 * so: replaced by another connection of this device (4000), whose
 * reconnecting would push this one off in turn, or signed out (4001).
 */
import {
  type ClientFrame,
  MAX_FRAME_BYTES,
  type ServerFrame,
  ServerFrameSchema,
} from "../../../../packages/remote-protocol/src";
import { SignedOutError } from "./errors";

/** Another connection of this device took its place in the room. */
export const CLOSE_REPLACED = 4000;
/** The device's sign-in ended: signed out, removed, or expired. */
export const CLOSE_SIGNED_OUT = 4001;

/**
 * Most characters a frame from the relay may take: the most a device may
 * send, and the sender's id the relay adds. A longer one is not read.
 */
export const MAX_DELIVERED_CHARS = MAX_FRAME_BYTES + 1024;

/**
 * - connecting: asking for a ticket, or opening the socket;
 * - online: in the room;
 * - waiting: lost, trying again after a while;
 * - replaced: another connection of this device took its place: not tried again;
 * - stopped: closed here.
 */
export type RelayStatus = "connecting" | "online" | "waiting" | "replaced" | "stopped";

type Socket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  addEventListener(type: string, listener: (event: never) => void): void;
};

export interface RelayConnectionDeps {
  /** The socket's address, with a fresh ticket: ws(s)://server/relay?v=1&ticket=... */
  url(): Promise<string>;
  onOpen(): void;
  onFrame(frame: ServerFrame): void;
  onStatus(status: RelayStatus): void;
  /** The relay or the server says the sign-in ended. */
  onSignedOut(): void;
  socket?: (url: string) => Socket;
  /** How long to wait before the `attempt`th try again, in ms. */
  backoff?: (attempt: number) => number;
}

/** 1 s doubling to 30 s, give or take a fifth, so devices do not come back all at once. */
export function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class RelayConnection {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private status: RelayStatus = "stopped";

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

  /** Sends a frame while online; false when it cannot go (offline, or too big). */
  send(frame: ClientFrame): boolean {
    if (this.status !== "online" || !this.socket) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return false;
    this.socket.send(text);
    return true;
  }

  /** The room answered: the connection is good, and the next loss starts the backoff over. */
  healthy(): void {
    this.attempt = 0;
  }

  private async connect(): Promise<void> {
    this.set("connecting");
    let url: string;
    try {
      url = await this.deps.url();
    } catch (error) {
      if (error instanceof SignedOutError) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else this.retry();
      return;
    }
    if (!this.running) return;
    const socket = (this.deps.socket ?? ((u) => new WebSocket(u) as Socket))(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.set("online");
      this.deps.onOpen();
    });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
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
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === CLOSE_REPLACED) this.giveUp("replaced");
      else if (event.code === CLOSE_SIGNED_OUT) {
        this.giveUp("stopped");
        this.deps.onSignedOut();
      } else this.retry();
    });
    // An error is followed by a close, which decides what comes next.
    socket.addEventListener("error", () => {});
  }

  private retry(): void {
    if (!this.running) return;
    this.set("waiting");
    const delay = (this.deps.backoff ?? defaultBackoff)(this.attempt);
    this.attempt += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running) void this.connect();
    }, delay);
  }

  private giveUp(status: RelayStatus): void {
    this.running = false;
    this.clearTimer();
    this.drop();
    this.set(status);
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= 1) socket.close(1000, "bye");
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
