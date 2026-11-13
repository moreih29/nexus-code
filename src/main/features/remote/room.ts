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
  PROTOCOL_VERSION,
  RPC_METHODS,
  type RpcError,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type SealedMessage,
  type ServerFrame,
} from "../../../../packages/remote-protocol/src";
import type { RoomPeer, RoomState, RoomStatus } from "../../../shared/remote/room";
import type { RelayConnectionDeps, RelayStatus } from "./relay-connection";
import { openMessage, type RoomKey, sealMessage } from "./seal";

/** How long an answer may take. */
export const REQUEST_TIMEOUT_MS = 15_000;

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
  /** What this device serves of its sessions, as its hello says. */
  readonly serves: readonly Capability[];
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

  /** Asks another device of the account; its answer, or a RpcFailure. */
  async request<M extends RpcMethod>(
    to: string,
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    const id = this.nextId++;
    const key = `${to}|${id}`;
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new RpcFailure(RpcErrorCode.Unavailable, `${method}: no answer in time`));
      }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timer, method });
    });
    const seq = await this.post(to, { jsonrpc: "2.0", id, method, params });
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

  private hello(reply: boolean): Hello {
    return {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      device: this.deps.self,
      app: this.deps.app,
      serves: [...this.deps.serves],
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
      this.peers.set(frame.from, { ...peer, app: message.app, serves: message.serves });
      this.changed();
      if (message.reply) void this.post(frame.from, this.hello(false));
      return;
    }
    if ("method" in message && "id" in message) {
      const answer = await this.answer(frame.from, message.method, message.params);
      void this.post(frame.from, { jsonrpc: "2.0", id: message.id, ...answer });
      return;
    }
    if ("method" in message) {
      this.deps.onNotification?.(frame.from, message.method, message.params);
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
    if (!this.deps.serves.includes(spec.capability as Capability)) {
      return { error: { code: RpcErrorCode.Forbidden, message: `${method} is not served here` } };
    }
    const parsed = spec.params.safeParse(params ?? {});
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
