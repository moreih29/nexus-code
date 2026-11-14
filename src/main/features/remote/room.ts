/**
 * This device in its account's room: it says hello as it joins and to each
 * device that does, keeps who is there, serves the requests the others
 * send it, and asks them its own (JSON-RPC, sealed; packages/remote-protocol).
 */
import {
  type Capability,
  type ClientFrame,
  type Delivered,
  type Hello,
  isRpcMethod,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  type RpcError,
  RpcErrorCode,
  type RpcMethod,
  type RpcNotificationMethod,
  type RpcNotificationParams,
  type RpcParams,
  type RpcResult,
  SCHEMA_VERSION,
  type SealedMessage,
  type ServerFrame,
} from "../../../../packages/remote-protocol/src";
import type { RoomPeer, RoomState, RoomStatus } from "../../../shared/remote/room";
import type { RelayConnectionDeps, RelayStatus } from "./relay-connection";
import { openMessage, type RoomKey, sealMessage } from "./seal";

/** How long an answer may take. */
export const REQUEST_TIMEOUT_MS = 15_000;

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
  stop(): void;
  send(frame: ClientFrame): boolean;
  healthy(): void;
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
  serve(request: { from: string; method: RpcMethod; params: unknown }): Promise<unknown>;
  onChange(state: RoomState): void;
  onNotification?(from: string, method: string, params: unknown): void;
  /** A message sealed with another version of the account key came: it may have been reset. */
  onForeignKey?(kid: number): void;
  onSignedOut(): void;
  readonly requestTimeoutMs?: number;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: RpcMethod;
  seq?: number;
}

export class RemoteRoom {
  private readonly connection: RoomConnection;
  private status: RoomStatus = "off";
  private peers = new Map<string, RoomPeer>();
  private seq = 0;
  private greeted = false;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: RemoteRoomDeps) {
    this.connection = deps.connect({
      onOpen: () => {
        // A new connection counts its messages from 1, and says hello again.
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

  stop(): void {
    this.connection.stop();
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcFailure(RpcErrorCode.Unavailable, "left the room"));
      this.pending.delete(key);
    }
    this.status = "off";
    this.changed();
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
    if (this.status === "online" && this.greeted) void this.post("*", this.hello(false));
  }

  /** Asks another device of the account; its answer, or a RpcFailure. */
  async request<M extends RpcMethod>(
    to: string,
    method: M,
    params: RpcParams<M>,
    /** How long to wait for the answer: longer for one the other device's user may be asked about. */
    timeoutMs?: number,
  ): Promise<RpcResult<M>> {
    const id = this.nextId++;
    const key = `${to}|${id}`;
    const message: SealedMessage = { jsonrpc: "2.0", id, method, params };
    if (!fitsInFrame(message)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${method}: too large to send`);
    }
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(key);
          reject(new RpcFailure(RpcErrorCode.Unavailable, `${method}: no answer in time`));
        },
        timeoutMs ?? this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      this.pending.set(key, { resolve, reject, timer, method });
    });
    const seq = await this.post(to, message);
    const p = this.pending.get(key);
    if (seq === null) {
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
        p.reject(new RpcFailure(RpcErrorCode.Unavailable, "not in the room"));
      }
    } else if (p) p.seq = seq;
    return answer as Promise<RpcResult<M>>;
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
    if (!fitsInFrame(message)) return false;
    return (await this.post(to, message)) !== null;
  }

  /** Seals and sends; its seq, or null when it could not go. */
  private async post(to: string, message: SealedMessage): Promise<number | null> {
    this.seq += 1;
    const seq = this.seq;
    const frame = await sealMessage({
      room: this.deps.room,
      from: this.deps.self.id,
      to,
      seq,
      message,
    });
    return this.connection.send(frame) ? seq : null;
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

  private onStatus(status: RelayStatus): void {
    this.status = status;
    if (status !== "online") {
      // Out of the room: none of the others is reachable until it is back.
      for (const peer of this.peers.values()) peer.online = false;
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
          name: d.name,
          platform: d.platform,
          online: d.online,
          ...(known?.app ? { app: known.app } : {}),
          ...(known?.serves ? { serves: known.serves } : {}),
        });
      }
      this.peers = next;
      if (!this.greeted) {
        this.greeted = true;
        void this.post("*", this.hello(true));
      }
      this.changed();
      return;
    }
    if (frame.t === "message") {
      void this.receive(frame);
      return;
    }
    if (frame.code === "no-such-device" && frame.seq !== undefined) {
      for (const [key, p] of this.pending) {
        if (p.seq !== frame.seq) continue;
        clearTimeout(p.timer);
        this.pending.delete(key);
        p.reject(new RpcFailure(RpcErrorCode.Unavailable, "that device is not in the room"));
      }
    } else if (frame.code !== "unauthorized") {
      console.warn(`[remote] relay: ${frame.code} ${frame.message}`);
    }
  }

  private async receive(frame: Delivered): Promise<void> {
    const message = await openMessage(this.deps.room, frame);
    if (!message) {
      if (frame.kid !== this.deps.room.kid) this.deps.onForeignKey?.(frame.kid);
      return;
    }
    if ("type" in message) {
      // The relay vouches for who sent it; a hello for another device is not taken.
      if (message.device.id !== frame.from) return;
      const peer = this.peers.get(frame.from) ?? {
        id: frame.from,
        name: message.device.name,
        platform: message.device.platform,
        online: true,
      };
      this.peers.set(frame.from, {
        ...peer,
        app: message.app,
        serves: message.serves,
        ...(message.schema ? { schema: message.schema } : {}),
      });
      this.changed();
      if (message.reply) void this.post(frame.from, this.hello(false));
      return;
    }
    if ("method" in message && "id" in message) {
      const answer = await this.answer(frame.from, message.method, message.params);
      const reply: SealedMessage = { jsonrpc: "2.0", id: message.id, ...answer };
      // Too large for a frame, it would never come: the asker is told so instead.
      void this.post(
        frame.from,
        fitsInFrame(reply)
          ? reply
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: RpcErrorCode.InternalError,
                message: `${message.method}: the answer is too large to send`,
              },
            },
      );
      return;
    }
    if ("method" in message) {
      const method = message.method;
      if (!Object.hasOwn(RPC_NOTIFICATIONS, method)) return;
      const parsed = RPC_NOTIFICATIONS[method as RpcNotificationMethod].safeParse(message.params);
      if (parsed.success) this.deps.onNotification?.(frame.from, method, parsed.data);
      return;
    }
    const key = `${frame.from}|${message.id}`;
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    if ("error" in message) {
      p.reject(new RpcFailure(message.error.code, message.error.message, message.error.data));
      return;
    }
    const result = RPC_METHODS[p.method].result.safeParse(message.result);
    if (result.success) p.resolve(result.data);
    else
      p.reject(
        new RpcFailure(RpcErrorCode.InternalError, `${p.method}: an answer not of the protocol`),
      );
  }

  private async answer(
    from: string,
    method: string,
    params: unknown,
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
    const needs = byAgent ? "agents" : (spec.capability as Capability);
    if (!this.serves().includes(needs)) {
      return {
        error: {
          code: RpcErrorCode.Forbidden,
          message: byAgent
            ? "control by agents is off there (Settings › Remote)"
            : `${method} is not served here`,
        },
      };
    }
    if (!parsed.success) {
      return { error: { code: RpcErrorCode.InvalidParams, message: parsed.error.message } };
    }
    try {
      return { result: await this.deps.serve({ from, method, params: parsed.data }) };
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
      console.warn(`[remote] serving ${method} failed:`, error);
      return {
        error: { code: RpcErrorCode.InternalError, message: "the device could not answer" },
      };
    }
  }

  private changed(): void {
    this.deps.onChange(this.state());
  }
}
