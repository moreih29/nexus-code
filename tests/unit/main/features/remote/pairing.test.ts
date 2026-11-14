/** A pairing through a QR code, as the desktop shows the code (ACCOUNT_KEYS.md, "Pairing"). */
import { describe, expect, test } from "bun:test";
import {
  type Delivered,
  PAIR_KID,
  type PairMessage,
  parsePairUri,
  type ServerFrame,
} from "../../../../../packages/remote-protocol/src";
import {
  openPair,
  type PairRouting,
  pairKeyOf,
  sealPair,
} from "../../../../../src/main/features/remote/device-key";
import { Pairing, type PairingSocket } from "../../../../../src/main/features/remote/pairing";
import type { RelayConnectionDeps } from "../../../../../src/main/features/remote/relay-connection";
import type { PairingState } from "../../../../../src/shared/remote/pairing";

const AK = new Uint8Array(32).fill(7);

function setup(options: { holds: boolean }) {
  const states: PairingState[] = [];
  const sent: { to: string; frame: Delivered }[] = [];
  const adopted: { kid: number; key: Uint8Array }[] = [];
  let handlers: Pick<RelayConnectionDeps, "onFrame"> | null = null;
  let roomSeq = 0;
  let socketSeq = 0;
  const socket: PairingSocket & { started: boolean; stopped: boolean } = {
    started: false,
    stopped: false,
    start() {
      this.started = true;
    },
    stop() {
      this.stopped = true;
    },
    send(frame) {
      socketSeq = frame.seq;
      sent.push({ to: frame.to, frame: { ...frame, t: "message", from: "dev-n" } });
      return true;
    },
  };
  const pairing = new Pairing({
    self: () => ({ userId: "u1", deviceId: "dev-n" }),
    holdsKey: () => options.holds,
    key: () => (options.holds ? { kid: 3, key: AK } : null),
    adopt: async (kid, key) => {
      adopted.push({ kid, key });
    },
    room: () =>
      options.holds
        ? {
            sendPair: async (to, seal) => {
              roomSeq += 1;
              const routing = { from: "dev-n", to, seq: roomSeq };
              const sealed = await seal(routing);
              sent.push({
                to,
                frame: { t: "message", to, from: "dev-n", seq: roomSeq, kid: PAIR_KID, ...sealed },
              });
              return true;
            },
            deviceName: (id) => (id === "dev-p" ? "iPhone" : undefined),
          }
        : null,
    connect: (h) => {
      handlers = h;
      return socket;
    },
    qr: async (text) => `qr:${text}`,
    onChange: (state) => states.push(state),
  });
  return {
    pairing,
    states,
    sent,
    adopted,
    socket,
    frameToSocket: (frame: ServerFrame) => handlers?.onFrame(frame),
    socketSeq: () => socketSeq,
  };
}

/** A frame from the device that scanned the code, sealed with its secret. */
async function fromScanner(uri: string, message: PairMessage, seq = 1): Promise<Delivered> {
  const code = parsePairUri(uri);
  if (!code) throw new Error("no code");
  const routing: PairRouting = { from: "dev-p", to: code.deviceId, seq };
  const sealed = await sealPair(
    pairKeyOf(code.secret, code.userId, code.deviceId),
    routing,
    message,
  );
  return { t: "message", ...routing, kid: PAIR_KID, ...sealed };
}

async function opened(uri: string, frame: Delivered) {
  const code = parsePairUri(uri);
  if (!code) throw new Error("no code");
  return openPair(pairKeyOf(code.secret, code.userId, code.deviceId), frame);
}

describe("pairing, holding the key", () => {
  test("a device that scanned the code asks; allowed, it gets the key", async () => {
    const { pairing, states, sent } = setup({ holds: true });
    const shown = await pairing.start();
    expect(shown).toMatchObject({ status: "showing", giving: true });
    if (shown.status !== "showing") throw new Error();
    expect(shown.qr).toBe(`qr:${shown.uri}`);
    pairing.onRoomFrame(await fromScanner(shown.uri, { t: "pair-request", v: 1 }));
    await Bun.sleep(5);
    expect(pairing.current()).toMatchObject({
      status: "asked",
      deviceId: "dev-p",
      deviceName: "iPhone",
    });
    // A second request meanwhile is not taken: the code is spent.
    pairing.onRoomFrame(await fromScanner(shown.uri, { t: "pair-request", v: 1 }, 2));
    await pairing.answer(true);
    expect(pairing.current()).toEqual({ status: "done", deviceName: "iPhone" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("dev-p");
    expect(await opened(shown.uri, sent[0]?.frame as Delivered)).toEqual({
      t: "pair-key",
      v: 1,
      kid: 3,
      key: Buffer.from(AK).toString("base64url"),
    });
    expect(states.map((s) => s.status)).toEqual(["showing", "asked", "done"]);
  });

  test("turned down, the device is told so and gets nothing", async () => {
    const { pairing, sent } = setup({ holds: true });
    const shown = await pairing.start();
    if (shown.status !== "showing") throw new Error();
    pairing.onRoomFrame(await fromScanner(shown.uri, { t: "pair-request", v: 1 }));
    await Bun.sleep(5);
    await pairing.answer(false);
    expect(pairing.current()).toEqual({ status: "failed", reason: "refused" });
    expect(await opened(shown.uri, sent[0]?.frame as Delivered)).toEqual({
      t: "pair-refused",
      v: 1,
    });
  });

  test("a frame sealed with another code is dropped", async () => {
    const { pairing } = setup({ holds: true });
    const first = await pairing.start();
    const second = await pairing.start();
    if (first.status !== "showing" || second.status !== "showing") throw new Error();
    pairing.onRoomFrame(await fromScanner(first.uri, { t: "pair-request", v: 1 }));
    await Bun.sleep(5);
    expect(pairing.current()).toMatchObject({ status: "showing" });
  });
});

describe("pairing, without the key", () => {
  test("a device holding the key scans the code and sends it; this one takes it and says so", async () => {
    const { pairing, sent, adopted, socket, frameToSocket } = setup({ holds: false });
    const shown = await pairing.start();
    expect(shown).toMatchObject({ status: "showing", giving: false });
    if (shown.status !== "showing") throw new Error();
    expect(socket.started).toBe(true);
    frameToSocket(
      await fromScanner(shown.uri, {
        t: "pair-key",
        v: 1,
        kid: 2,
        key: Buffer.from(AK).toString("base64url"),
      }),
    );
    await Bun.sleep(10);
    expect(adopted).toEqual([{ kid: 2, key: new Uint8Array(Buffer.from(AK)) }]);
    expect(pairing.current()).toEqual({ status: "done" });
    expect(sent[0]?.to).toBe("dev-p");
    expect(await opened(shown.uri, sent[0]?.frame as Delivered)).toEqual({ t: "pair-done", v: 1 });
    expect(socket.stopped).toBe(true);
  });

  test("stopping drops the socket and the code", async () => {
    const { pairing, socket } = setup({ holds: false });
    await pairing.start();
    expect(pairing.stop()).toEqual({ status: "idle" });
    expect(socket.stopped).toBe(true);
  });
});
