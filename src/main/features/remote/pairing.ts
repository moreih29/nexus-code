import {
  type Delivered,
  PAIR_KID,
  PAIR_TTL_MS,
  type PairMessage,
  pairUriOf,
  type ServerFrame,
} from "../../../../packages/remote-protocol/src";
import type { PairingState } from "../../../shared/remote/pairing";
import { newPairSecret, openPair, type PairRouting, pairKeyOf, sealPair } from "./device-key";
import type { RelayConnectionDeps, RelayStopReason } from "./relay-connection";

const ASK_MS = 60_000;

type Seal = (routing: PairRouting) => Promise<{ nonce: string; box: string }>;

export interface PairingRoom {
  sendPair(to: string, seal: Seal): Promise<boolean>;
  deviceName(id: string): string | undefined;
}

export interface PairingSocket {
  start(): void;
  stop(reason?: RelayStopReason): void;
  send(frame: {
    t: "send";
    to: string;
    seq: number;
    kid: number;
    nonce: string;
    box: string;
  }): boolean;
}

export interface PairingDeps {
  self(): { userId: string; deviceId: string } | null;
  holdsKey(): boolean;
  key(): { kid: number; key: Uint8Array } | null;
  adopt(kid: number, key: Uint8Array): Promise<unknown>;
  room(): PairingRoom | null;
  connect(
    handlers: Pick<RelayConnectionDeps, "onOpen" | "onFrame" | "onStatus" | "onSignedOut">,
  ): PairingSocket;
  qr(text: string): Promise<string>;
  onChange(state: PairingState): void;
  readonly now?: () => number;
}

interface Showing {
  readonly secret: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly giving: boolean;
  readonly expiresAt: number;
  asked?: string;
  readonly socket: PairingSocket | null;
  seq: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Pairing {
  private state: PairingState = { status: "idle" };
  private showing: Showing | null = null;

  constructor(private readonly deps: PairingDeps) {}

  current(): PairingState {
    return this.state;
  }

  async start(): Promise<PairingState> {
    this.drop();
    const self = this.deps.self();
    if (!self) return this.set({ status: "failed", reason: "unavailable" });
    const giving = this.deps.holdsKey();
    if (giving && !this.deps.room()) return this.set({ status: "failed", reason: "offline" });
    const secret = newPairSecret();
    const expiresAt = this.now() + PAIR_TTL_MS;
    const uri = pairUriOf({ v: 1, userId: self.userId, deviceId: self.deviceId, secret });
    const socket = giving
      ? null
      : this.deps.connect({
          onOpen: () => {
            if (this.showing?.socket === socket) this.showing.seq = 0;
          },
          onFrame: (frame) => this.onSocketFrame(socket, frame),
          onStatus: () => {},
          onSignedOut: () => {
            if (this.showing?.socket === socket) this.fail("unavailable");
          },
        });
    this.showing = {
      secret,
      userId: self.userId,
      deviceId: self.deviceId,
      giving,
      expiresAt,
      socket,
      seq: 0,
      timer: setTimeout(() => this.expire(), Math.max(0, expiresAt - this.now())),
    };
    socket?.start();
    const qr = await this.deps.qr(uri);
    if (this.showing?.secret !== secret) return this.state;
    return this.set({ status: "showing", uri, qr, expiresAt, giving });
  }

  stop(): PairingState {
    this.drop();
    return this.set({ status: "idle" });
  }

  async answer(allow: boolean): Promise<PairingState> {
    const showing = this.showing;
    const to = showing?.asked;
    const key = this.deps.key();
    const room = this.deps.room();
    if (!showing || !to) return this.state;
    if (!allow) {
      if (room) await this.send(showing, to, { t: "pair-refused", v: 1 });
      this.drop();
      return this.set({ status: "failed", reason: "refused" });
    }
    if (!key || !room) return this.fail("offline");
    const sent = await this.send(showing, to, {
      t: "pair-key",
      v: 1,
      kid: key.kid,
      key: Buffer.from(key.key).toString("base64url"),
    });
    const name = room.deviceName(to);
    this.drop();
    if (!sent) return this.fail("offline");
    return this.set({ status: "done", ...(name ? { deviceName: name } : {}) });
  }

  onRoomFrame(frame: Delivered): void {
    void this.take(frame);
  }

  private onSocketFrame(socket: PairingSocket | null, frame: ServerFrame): void {
    if (this.showing?.socket !== socket || frame.t !== "message") return;
    if (frame.kid !== PAIR_KID || frame.to !== this.showing?.deviceId) return;
    void this.take(frame);
  }

  private async take(frame: Delivered): Promise<void> {
    const showing = this.showing;
    if (!showing || showing.asked || this.state.status !== "showing") return;
    const key = pairKeyOf(showing.secret, showing.userId, showing.deviceId);
    const message = await openPair(key, frame);
    if (!message || this.showing !== showing) return;
    if (showing.giving ? message.t === "pair-key" : message.t === "pair-request") {
      await this.send(showing, frame.from, { t: "pair-refused", v: 1 });
      return;
    }
    if (showing.giving && message.t === "pair-request") {
      showing.asked = frame.from;
      clearTimeout(showing.timer);
      const expiresAt = this.now() + ASK_MS;
      showing.timer = setTimeout(() => void this.answer(false), ASK_MS);
      const name = this.deps.room()?.deviceName(frame.from);
      this.set({
        status: "asked",
        deviceId: frame.from,
        ...(name ? { deviceName: name } : {}),
        expiresAt,
      });
      return;
    }
    if (!showing.giving && message.t === "pair-key") {
      showing.asked = frame.from;
      try {
        await this.deps.adopt(message.kid, Buffer.from(message.key, "base64url"));
      } catch {
        this.drop();
        this.set({ status: "failed", reason: "unavailable" });
        return;
      }
      await this.send(showing, frame.from, { t: "pair-done", v: 1 });
      this.drop();
      this.set({ status: "done" });
      return;
    }
    if (message.t === "pair-refused") this.fail("refused");
  }

  private async send(showing: Showing, to: string, message: PairMessage): Promise<boolean> {
    const key = pairKeyOf(showing.secret, showing.userId, showing.deviceId);
    const seal: Seal = (routing) => sealPair(key, routing, message);
    if (showing.socket) {
      showing.seq += 1;
      const seq = showing.seq;
      const sealed = await seal({ from: showing.deviceId, to, seq });
      return showing.socket.send({ t: "send", to, seq, kid: PAIR_KID, ...sealed });
    }
    return (await this.deps.room()?.sendPair(to, seal)) ?? false;
  }

  private expire(): void {
    if (!this.showing) return;
    const asked = this.showing.asked;
    if (asked) return;
    this.fail("expired");
  }

  private fail(reason: "expired" | "refused" | "offline" | "unavailable"): PairingState {
    this.drop();
    return this.set({ status: "failed", reason });
  }

  private drop(): void {
    const showing = this.showing;
    if (!showing) return;
    this.showing = null;
    clearTimeout(showing.timer);
    showing.socket?.stop("pairing-ended");
  }

  private set(state: PairingState): PairingState {
    this.state = state;
    this.deps.onChange(state);
    return state;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
