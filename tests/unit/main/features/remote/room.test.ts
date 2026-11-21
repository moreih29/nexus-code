/** Devices of one account in a room, through an in-memory relay. */
import { describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as flushRelay } from "node:timers/promises";
import type {
  ClientFrame,
  Delivered,
  RoomDevice,
  ServerFrame,
} from "../../../../../packages/remote-protocol/src";
import {
  MAX_BYTES_CHUNK,
  RPC_METHODS,
  RpcErrorCode,
  type RpcParams,
  SCHEMA_VERSION,
} from "../../../../../packages/remote-protocol/src";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { newAccountKey, roomKeyOf } from "../../../../../src/main/features/remote/account-key";
import { AgentGate } from "../../../../../src/main/features/remote/agent-gate";
import { FileWrites } from "../../../../../src/main/features/remote/file-writes";
import { PeerFileReads } from "../../../../../src/main/features/remote/peer-file-reads";
import type { RelayConnectionDeps } from "../../../../../src/main/features/remote/relay-connection";
import {
  MAX_MESSAGE_BYTES,
  RemoteRoom,
  type RemoteRoomDeps,
  RpcFailure,
} from "../../../../../src/main/features/remote/room";
import { openMessage, type RoomKey } from "../../../../../src/main/features/remote/seal";

import { servesWith, serveWith } from "../../../../../src/main/features/remote/serve";
import { mainWarnMock } from "../../../../log-test-spies";
import { fakeApp } from "../../cli/fake-services";

type Handlers = Pick<RelayConnectionDeps, "onOpen" | "onFrame" | "onStatus" | "onSignedOut">;

/** The relay, as the contract has it: stamps `from`, routes, tells who is in. */
class MockRelay {
  readonly devices: RoomDevice[] = [];
  private readonly online = new Map<string, Handlers>();
  /** Changes a frame on its way, as a relay that cheats would. */
  tamper: ((frame: ServerFrame) => ServerFrame) | null = null;
  drop:
    | ((from: string, frame: ClientFrame) => "silent" | "rate-limited" | "legacy-limit" | undefined)
    | null = null;
  /** Every message it passed on, as it delivered it: a relay that cheats may send one again. */
  readonly kept: { to: string; frame: Delivered }[] = [];

  connection(device: Omit<RoomDevice, "online">, handlers: Handlers) {
    if (!this.devices.some((d) => d.id === device.id))
      this.devices.push({ ...device, online: false });
    let recoveries = 0;
    return {
      start: () => {
        handlers.onStatus("connecting");
        this.online.set(device.id, handlers);
        handlers.onOpen();
        handlers.onStatus("online");
        this.presence();
      },
      stop: () => {
        this.online.delete(device.id);
        handlers.onStatus("stopped");
        this.presence();
      },
      healthy: () => {},
      /** The socket dropped and opened again, as a new connection. */
      reopen: () => {
        handlers.onStatus("waiting");
        handlers.onOpen();
        handlers.onStatus("online");
        this.presence();
      },
      recover: () => {
        recoveries++;
        handlers.onStatus("waiting");
        handlers.onOpen();
        handlers.onStatus("online");
        this.presence();
      },
      recoveries: () => recoveries,
      send: (frame: ClientFrame) => {
        queueMicrotask(() => this.route(device.id, frame));
        return true;
      },
    };
  }

  private route(from: string, frame: ClientFrame) {
    const dropped = this.drop?.(from, frame);
    if (dropped) {
      if (dropped !== "silent")
        this.online.get(from)?.onFrame({
          t: "error",
          code: "rate-limited",
          message: "",
          ...(dropped === "rate-limited" ? { seq: frame.seq } : {}),
        });
      return;
    }
    const targets =
      frame.to === "*"
        ? [...this.online.keys()].filter((id) => id !== from)
        : this.online.has(frame.to)
          ? [frame.to]
          : [];
    if (frame.to !== "*" && targets.length === 0) {
      this.online
        .get(from)
        ?.onFrame({ t: "error", code: "no-such-device", message: "", seq: frame.seq });
      return;
    }
    for (const id of targets) {
      const delivered: Delivered = { ...frame, t: "message", from };
      this.kept.push({ to: id, frame: delivered });
      this.online.get(id)?.onFrame(this.tamper ? this.tamper(delivered) : delivered);
    }
  }

  /** Sends a kept message again, to the device given. */
  deliver(to: string, frame: Delivered) {
    this.online.get(to)?.onFrame(frame);
  }

  /** The kept messages one device sent, as delivered to another. */
  between(from: string, to: string) {
    return this.kept.filter((k) => k.frame.from === from && k.to === to).map((k) => k.frame);
  }

  private presence() {
    for (const [id, handlers] of this.online) {
      handlers.onFrame({
        t: "presence",
        self: id,
        devices: this.devices.map((d) => ({ ...d, online: this.online.has(d.id) })),
      });
    }
  }
}

// Initialize sodium before the fake relay starts so frame delivery can drain
// through microtasks when a test yields to the next event-loop turn.
async function roomKey(): Promise<RoomKey> {
  return { kid: 1, key: roomKeyOf(await newAccountKey()) };
}

function device(relay: MockRelay, id: string, key: RoomKey, extra: Partial<RemoteRoomDeps> = {}) {
  const self = extra.self ?? { id, name: `${id}-pc`, platform: "darwin" };
  const served: { from: string; method: string }[] = [];
  let connection: ReturnType<MockRelay["connection"]> | undefined;
  const room = new RemoteRoom({
    self,
    room: key,
    app: { name: "NexusCode", version: "0.0.0-test" },
    serves: ["sessions"],
    connect: (handlers) => {
      connection = relay.connection(self, handlers);
      return connection;
    },
    serve: async ({ from, method }) => {
      served.push({ from, method });
      return { workspaces: [{ id: "w1", name: "ws", path: "/ws" }], sessions: [] };
    },
    onChange: () => {},
    onSignedOut: () => {},
    requestTimeoutMs: 300,
    ...extra,
  });
  return {
    room,
    served,
    reopen: () => connection?.reopen(),
    recoveries: () => connection?.recoveries(),
  };
}

describe("the room", () => {
  test("devices say hello, see each other, and answer each other's requests", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    expect(b.room.state()).toEqual({
      status: "online",
      peers: [
        {
          id: "a",
          name: "a-pc",
          platform: "darwin",
          online: true,
          app: { name: "NexusCode", version: "0.0.0-test" },
          serves: ["sessions"],
          // The protocol version it speaks, so the other leaves out what it lacks.
          schema: SCHEMA_VERSION,
        },
      ],
    });
    expect(a.room.state().peers[0]?.serves).toEqual(["sessions"]);

    const list = await b.room.request("a", "sessions.list", {});
    expect(list.workspaces[0]?.name).toBe("ws");
    expect(a.served).toEqual([{ from: "b", method: "sessions.list" }]);
  });

  test("a device with an alias is named by it, with the name it signed in with beside it", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    const known = relay.devices.find((d) => d.id === "a") as RoomDevice;
    known.alias = "Studio";
    b.reopen();
    await flushRelay();
    expect(b.room.state().peers[0]).toMatchObject({ id: "a", name: "Studio", hostName: "a-pc" });
    known.alias = null;
    b.reopen();
    await flushRelay();
    const peer = b.room.state().peers[0];
    expect(peer?.name).toBe("a-pc");
    expect(peer && "hostName" in peer).toBe(false);
  });

  test("refuses what it does not serve, and params not of the protocol", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    await expect(
      b.room.request("a", "terminal.read", { workspaceId: "w", tabId: "t" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    await expect(
      b.room.request("a", "sessions.unwatch", {} as { watchId: string }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    expect(a.served).toEqual([]);
  });

  test("an agent's request goes as agents may act there, not as people may", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let serves = ["sessions", "chat.control"];
    const a = device(relay, "a", key, { serves: () => serves });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    const tab = { workspaceId: "w1", tabId: "t1" };
    const from = { kind: "tab" as const, workspaceId: "bw", tabId: "bt" };
    // People may control the chats; agents may not.
    await expect(b.room.request("a", "chat.interrupt", { ...tab, from })).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("control by agents is off"),
    });
    expect(a.served).toEqual([]);
    // Agents may, but people may not: neither may, for an agent does no more than people may.
    serves = ["sessions", "agents"];
    a.room.announce();
    await flushRelay();
    for (const params of [{ ...tab, from }, tab]) {
      await expect(b.room.request("a", "chat.interrupt", params)).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
        message: "chat.interrupt is not served here",
      });
    }
    expect(a.served).toEqual([]);
    // Both may.
    serves = ["sessions", "chat.control", "agents"];
    a.room.announce();
    await flushRelay();
    await b.room.request("a", "chat.interrupt", { ...tab, from });
    expect(a.served).toEqual([{ from: "b", method: "chat.interrupt" }]);
  });

  test("an agent's request from a phone is refused: no agent runs there", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key, { serves: () => ["sessions", "chat.control", "agents"] });
    const phone = device(relay, "p", key, {
      self: { id: "p", name: "phone", platform: "ios" },
    });
    a.room.start();
    phone.room.start();
    await flushRelay();
    const tab = { workspaceId: "w1", tabId: "t1" };
    const from = { kind: "tab" as const, workspaceId: "pw", tabId: "pt" };
    await expect(phone.room.request("a", "chat.interrupt", { ...tab, from })).rejects.toMatchObject(
      { code: RpcErrorCode.Forbidden, message: "agents' requests are not taken from a phone" },
    );
    await phone.room.request("a", "chat.interrupt", tab);
    expect(a.served).toEqual([{ from: "p", method: "chat.interrupt" }]);
  });

  test("an agent's request to a method that takes none from agents is refused, not taken as the user's", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key, { serves: () => ["sessions", "chat.control", "agents"] });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    const from = { kind: "tab" as const, workspaceId: "bw", tabId: "bt" };
    // consent.answer's params have no `from`: parsing them drops it.
    const params = { id: "c1", answer: "once" as const, from } as { id: string; answer: "once" };
    await expect(b.room.request("a", "consent.answer", params)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: "consent.answer is not taken from agents",
    });
    expect(a.served).toEqual([]);
    await b.room.request("a", "consent.answer", { id: "c1", answer: "once" });
    expect(a.served).toEqual([{ from: "b", method: "consent.answer" }]);
  });

  test("profile defaults require chat control and a user sender", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let allowed = false;
    const a = device(relay, "a", key, {
      serves: () => (allowed ? ["sessions", "chat.control", "agents"] : ["sessions"]),
      serve: async () => ({}),
    });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    const params = { workspaceId: "w1", tabId: "t1", set: { changes: { web_search: "disabled" } } };
    await expect(b.room.request("a", "chat.config", params)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: "chat.config is not served here",
    });
    allowed = true;
    const from = { kind: "tab" as const, workspaceId: "bw", tabId: "bt" };
    const relayed = { ...params, from };
    await expect(b.room.request("a", "chat.config", relayed)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: "chat.config is not taken from agents",
    });
    await expect(b.room.request("a", "chat.config", params)).resolves.toEqual({});
  });

  test("tells the room again when what it serves changed, and refuses what it no longer does", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let control = true;
    const a = device(relay, "a", key, {
      serves: () => (control ? ["sessions", "chat.control"] : ["sessions"]),
    });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions", "chat.control"]);
    control = false;
    a.room.announce();
    await flushRelay();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions"]);
    await expect(
      b.room.request("a", "chat.interrupt", { workspaceId: "w1", tabId: "t1" }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
  });

  test("its hello says the app's theme, and says it again once it changed", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let theme = "github-dark";
    const a = device(relay, "a", key, { theme: () => theme });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    expect(b.room.state().peers[0]?.app).toEqual({
      name: "NexusCode",
      version: "0.0.0-test",
      theme: "github-dark",
    });
    // One that tells none says none.
    expect(a.room.state().peers[0]?.app).toEqual({ name: "NexusCode", version: "0.0.0-test" });
    theme = "github-light";
    a.room.announce();
    await flushRelay();
    expect(b.room.state().peers[0]?.app.theme).toBe("github-light");
  });

  test("a device that left is told as unavailable", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    a.room.stop();
    await flushRelay();
    expect(b.room.state().peers[0]?.online).toBe(false);
    const asked = b.room.request("a", "sessions.list", {});
    await expect(asked).rejects.toBeInstanceOf(RpcFailure);
    await expect(asked).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
  });

  test("a message the relay changed on its way does not open", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    relay.tamper = (frame) => (frame.t === "message" ? { ...frame, seq: frame.seq + 1 } : frame);
    await expect(b.room.request("a", "sessions.list", {})).rejects.toMatchObject({
      code: RpcErrorCode.Unavailable,
    });
    expect(a.served).toEqual([]);
  });

  test("a message sealed with a newer key version is told, once a minute, and not opened", async () => {
    const relay = new MockRelay();
    const foreign: number[] = [];
    const older: number[] = [];
    const a = device(relay, "a", await roomKey(), { onForeignKey: (kid) => foreign.push(kid) });
    const b = device(
      relay,
      "b",
      { kid: 2, key: roomKeyOf(await newAccountKey()) },
      { onForeignKey: (kid) => older.push(kid) },
    );
    a.room.start();
    b.room.start();
    await flushRelay();
    for (const frame of relay.between("b", "a")) relay.deliver("a", frame);
    await flushRelay();
    expect(foreign).toEqual([2]);
    expect(a.room.state().peers[0]?.serves).toBeUndefined();
    // An older version is no reset: the key is not fetched for it.
    for (const frame of relay.between("a", "b")) relay.deliver("b", frame);
    await flushRelay();
    expect(older).toEqual([]);
  });
});

describe("what the relay keeps and sends again", () => {
  async function pair() {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    return { relay, key, a, b };
  }

  test("a message sent again is not taken twice", async () => {
    const { relay, a, b } = await pair();
    await b.room.request("a", "sessions.list", {});
    for (const frame of relay.between("b", "a")) relay.deliver("a", frame);
    await flushRelay();
    expect(a.served).toHaveLength(1);
  });

  test("a stale request repairs the peer epoch and repeated stale requests share one hello", async () => {
    const { relay, key, a, b } = await pair();
    relay.drop = (from) => (from === "a" ? "silent" : undefined);
    a.reopen();
    await flushRelay();
    relay.drop = null;
    jest.useFakeTimers();
    try {
      const first = b.room.request("a", "sessions.list", {});
      const second = b.room.request("a", "sessions.list", {});
      await flushRelay();
      const targeted = relay.between("a", "b").filter((frame) => frame.to === "b");
      const heard = await Promise.all(targeted.map((frame) => openMessage(key, frame)));
      const recent = heard.at(-1);
      expect(
        heard.filter((item) => item && item.epoch === recent?.epoch && "type" in item.message),
      ).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ type: "hello", reply: true }),
        }),
      ]);
      expect(b.room.state().peers[0]?.rejoins).toBe(1);
      expect((await first).workspaces).toHaveLength(1);
      expect((await second).workspaces).toHaveLength(1);
      expect(a.served).toHaveLength(2);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test("request timeouts send one recovery hello without counting a rejoin", async () => {
    const { relay, key, a, b } = await pair();
    jest.useFakeTimers();
    try {
      relay.drop = (from) => (from === "b" ? "silent" : undefined);
      const requests = Array.from({ length: 2 }, () =>
        b.room.request("a", "sessions.list", {}).catch((e: unknown) => e),
      );
      await flushRelay();
      const before = relay.between("b", "a").length;
      relay.drop = null;
      jest.advanceTimersByTime(300);
      await flushRelay();
      const sent = relay.between("b", "a").slice(before);
      expect(sent).toHaveLength(1);
      expect((await openMessage(key, sent[0]!))?.message).toMatchObject({
        type: "hello",
        reply: true,
      });
      expect(a.room.state().peers[0]?.rejoins).toBeUndefined();
      expect(b.room.state().peers[0]?.rejoins).toBeUndefined();
      expect(await Promise.all(requests)).toEqual([expect.any(RpcFailure), expect.any(RpcFailure)]);
      expect((await b.room.request("a", "sessions.list", {})).workspaces).toHaveLength(1);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test.each([
    "b",
    "a",
  ])("a rate-limited frame from %s fails the affected request", async (sender) => {
    const { relay, a, b } = await pair();
    jest.useFakeTimers();
    try {
      relay.drop = (from) => {
        if (from !== sender) return;
        relay.drop = null;
        return "rate-limited";
      };
      const warningsBefore = mainWarnMock.mock.calls.length;
      const failed = b.room.request("a", "sessions.list", {}, 10_000).catch((e: unknown) => e);
      await flushRelay();
      if (sender === "a") {
        jest.advanceTimersByTime(1_100);
        await flushRelay();
      }
      expect(await failed).toMatchObject({
        code: RpcErrorCode.Unavailable,
        message: expect.stringContaining("rate limiting"),
      });
      expect(
        mainWarnMock.mock.calls.slice(warningsBefore).map(([message]) => message),
      ).toContainEqual(expect.stringContaining("Relay rejected frame code=rate-limited"));
      expect(a.served).toHaveLength(sender === "a" ? 1 : 0);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test("a rate limit without a sequence pauses sending without rejecting another request", async () => {
    const { relay, a, b } = await pair();
    jest.useFakeTimers();
    try {
      relay.drop = (from) => {
        if (from !== "b") return;
        relay.drop = null;
        return "legacy-limit";
      };
      const first = b.room.request("a", "sessions.list", {}, 10_000).catch((e: unknown) => e);
      await flushRelay();
      const second = b.room.request("a", "sessions.list", {}, 10_000);
      jest.advanceTimersByTime(999);
      await flushRelay();
      expect(a.served).toHaveLength(0);
      jest.advanceTimersByTime(100);
      await flushRelay();
      expect((await second).workspaces).toHaveLength(1);
      expect(a.served).toHaveLength(1);
      b.room.stop();
      expect(await first).toBeInstanceOf(RpcFailure);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test("an outgoing seal stall reconnects and clears requests queued on the old socket", async () => {
    const { a, b } = await pair();
    jest.useFakeTimers();
    try {
      const pairing = b.room.sendPair("a", () => new Promise(() => {}));
      await flushRelay();
      const waiting = b.room.request("a", "sessions.list", {}, 10_000).catch((e: unknown) => e);
      jest.advanceTimersByTime(5_000);
      await flushRelay();
      expect(b.recoveries()).toBe(1);
      expect(await pairing).toBe(false);
      expect(await waiting).toMatchObject({ workspaces: [{ id: "w1" }] });
      expect(a.served).toHaveLength(1);
      expect((await b.room.request("a", "sessions.list", {})).workspaces).toHaveLength(1);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test("a late outbox watchdog lets queued requests survive a blocked event loop", async () => {
    const { a, b } = await pair();
    jest.useFakeTimers();
    const now = performance.now.bind(performance);
    let slipMs = 0;
    const clock = jest.spyOn(performance, "now").mockImplementation(() => now() + slipMs);
    try {
      const seal = Promise.withResolvers<{ nonce: string; box: string }>();
      const pairing = b.room.sendPair("a", () => seal.promise);
      await flushRelay();
      const waiting = b.room
        .request("a", "sessions.list", {}, 20_000)
        .catch((error: unknown) => error);

      slipMs = 2_000;
      jest.advanceTimersByTime(5_000);
      await flushRelay();
      expect(b.recoveries()).toBe(0);
      expect(a.served).toHaveLength(0);

      seal.resolve({ nonce: "", box: "" });
      expect(await pairing).toBe(true);
      expect(await waiting).toMatchObject({ workspaces: [{ id: "w1" }] });
      jest.advanceTimersByTime(5_000);
      expect(b.recoveries()).toBe(0);
    } finally {
      a.room.stop();
      b.room.stop();
      clock.mockRestore();
      jest.useRealTimers();
    }
  });

  test("a live socket with two silent online peers reconnects after its hello probes", async () => {
    const { relay, key, a, b } = await pair();
    const c = device(relay, "c", key);
    c.room.start();
    await flushRelay();
    jest.useFakeTimers();
    try {
      relay.drop = (from) => (from === "b" ? "silent" : undefined);
      const waiting = b.room.request("a", "sessions.list", {}).catch((e: unknown) => e);
      await flushRelay();
      jest.advanceTimersByTime(300);
      await flushRelay();
      expect(await waiting).toBeInstanceOf(RpcFailure);
      expect(b.room.state().status).toBe("online");
      relay.drop = null;
      jest.advanceTimersByTime(5_000);
      await flushRelay();
      expect(b.recoveries()).toBe(1);
      expect((await b.room.request("c", "sessions.list", {})).workspaces).toHaveLength(1);
    } finally {
      a.room.stop();
      b.room.stop();
      c.room.stop();
      jest.useRealTimers();
    }
  });

  test("a message of an earlier connection is not taken in a new one", async () => {
    const { relay, a, b } = await pair();
    await b.room.request("a", "sessions.list", {});
    const kept = relay.between("b", "a");
    // Days later, both connected again.
    a.reopen();
    b.reopen();
    await flushRelay();
    for (const frame of kept) relay.deliver("a", frame);
    await flushRelay();
    expect(a.served).toHaveLength(1);
    // The two said hello again: a new request goes.
    await b.room.request("a", "sessions.list", {});
    expect(a.served).toHaveLength(2);
  });

  test("once a device's new connection is heard, its old one's messages are not taken", async () => {
    const { relay, a, b } = await pair();
    await b.room.request("a", "sessions.list", {});
    const kept = relay.between("b", "a");
    b.reopen();
    await flushRelay();
    // Sealed for a's epoch, which has not changed, but in b's old one.
    for (const frame of kept) relay.deliver("a", frame);
    await flushRelay();
    expect(a.served).toHaveLength(1);
    await b.room.request("a", "sessions.list", {});
    expect(a.served).toHaveLength(2);
  });

  test("a device back with a new connection the room never showed gone is counted, for its watches to be asked again", async () => {
    const { a, b } = await pair();
    expect(b.room.state().peers[0]?.rejoins).toBeUndefined();
    // a's socket dropped and opened again; the room showed it online all the while.
    a.reopen();
    await flushRelay();
    expect(b.room.state().peers[0]).toMatchObject({ id: "a", online: true, rejoins: 1 });
    // a itself started over: it counts none of b.
    expect(a.room.state().peers[0]?.rejoins).toBeUndefined();
    // Told again in each presence, and once more for the next connection.
    a.reopen();
    await flushRelay();
    expect(b.room.state().peers[0]?.rejoins).toBe(2);
    // b asks a as before.
    await b.room.request("a", "sessions.list", {});
    expect(a.served).toHaveLength(1);
  });

  test("a message for another device, passed on to this one, is not taken", async () => {
    const { relay, key, a, b } = await pair();
    const c = device(relay, "c", key);
    c.room.start();
    await flushRelay();
    await b.room.request("a", "sessions.list", {});
    for (const frame of relay.between("b", "a")) {
      relay.deliver("c", frame);
      // Its `to` is sealed with it: changed, it does not open.
      relay.deliver("c", { ...frame, to: "c" });
    }
    await flushRelay();
    expect(c.served).toEqual([]);
    expect(a.served).toHaveLength(1);
  });

  test("an old hello sent again does not bring back what the device served", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let serves = ["sessions", "chat.control"];
    const a = device(relay, "a", key, { serves: () => serves });
    const b = device(relay, "b", key);
    b.room.start();
    a.room.start();
    await flushRelay();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions", "chat.control"]);
    const kept = [...relay.between("a", "b")];
    serves = ["sessions"];
    a.room.announce();
    await flushRelay();
    for (const frame of kept) relay.deliver("b", frame);
    await flushRelay();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions"]);
  });

  test("a local reconnect retries a read and fails a sent chat message without replaying it", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const methods: string[] = [];
    let reads = 0;
    const a = device(relay, "a", key, {
      serves: ["sessions", "chat.control"],
      serve: async ({ method }) => {
        methods.push(method);
        if (method === "chat.send" || ++reads === 1) return new Promise(() => {});
        return { workspaces: [], sessions: [] };
      },
    });
    const b = device(relay, "b", key, { requestTimeoutMs: 10_000 });
    a.room.start();
    b.room.start();
    await flushRelay();
    try {
      const asked = b.room.request("a", "sessions.list", {});
      const mutation = b.room
        .request("a", "chat.send", { workspaceId: "w", tabId: "t", text: "hi" })
        .catch((error: unknown) => error);
      await flushRelay();
      b.reopen();
      await flushRelay();
      expect(await mutation).toMatchObject({
        code: RpcErrorCode.Unavailable,
        message: "the connection to the room was lost",
        data: { outcome: "unknown" },
      });
      expect(await asked).toEqual({ workspaces: [], sessions: [] });
      expect(methods).toEqual(["sessions.list", "chat.send", "sessions.list"]);
    } finally {
      a.room.stop();
      b.room.stop();
    }
  });

  test.each([
    "deadline",
    "another reconnect",
  ] as const)("a retained read stops at its original %s", async (reason) => {
    const relay = new MockRelay();
    const key = await roomKey();
    let reads = 0;
    const a = device(relay, "a", key, {
      serve: () => {
        reads++;
        return new Promise(() => {});
      },
    });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await flushRelay();
    jest.useFakeTimers();
    try {
      const asked = b.room
        .request("a", "sessions.list", {}, 1_000)
        .catch((error: unknown) => error);
      await flushRelay();
      jest.advanceTimersByTime(600);
      a.reopen();
      await flushRelay();
      expect(reads).toBe(2);
      if (reason === "deadline") jest.advanceTimersByTime(400);
      else b.reopen();
      await flushRelay();
      expect(await asked).toMatchObject({
        message:
          reason === "deadline"
            ? "sessions.list: no answer in time"
            : "the connection to the room was lost",
      });
      expect(reads).toBe(2);
    } finally {
      a.room.stop();
      b.room.stop();
      jest.useRealTimers();
    }
  });

  test("an online peer without a known epoch gets a hello before the first request", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    relay.drop = (from) => (from === "a" ? "silent" : undefined);
    a.room.start();
    b.room.start();
    await flushRelay();
    try {
      expect(b.room.state().peers[0]).toMatchObject({ id: "a", online: true });
      expect(b.room.state().peers[0]?.serves).toBeUndefined();
      const oldFrames = relay.between("b", "a").length;
      relay.drop = null;
      const answer = b.room.request("a", "sessions.list", {}, 3_000);
      await flushRelay();
      expect((await answer).workspaces).toHaveLength(1);
      const sent = relay.between("b", "a").slice(oldFrames);
      expect(sent[0]?.to).toBe("*");
      expect((await openMessage(key, sent.at(-1)!))?.message).toMatchObject({
        method: "sessions.list",
      });
      expect(a.served).toHaveLength(1);
    } finally {
      a.room.stop();
      b.room.stop();
    }
  });

  test("a read rejected by the relay while a peer is between sockets resumes on its hello", async () => {
    const { a, b } = await pair();
    const reading = b.room.request("a", "sessions.list", {}, 1_000);
    a.room.stop();
    await flushRelay();
    try {
      expect(a.served).toHaveLength(0);
      a.room.start();
      expect((await reading).workspaces).toHaveLength(1);
      expect(a.served).toHaveLength(1);
    } finally {
      a.room.stop();
      b.room.stop();
    }
  });

  test("nothing goes to a device it has not heard a hello from", async () => {
    const relay = new MockRelay();
    const a = device(relay, "a", await roomKey());
    a.room.start();
    await expect(a.room.request("x", "sessions.list", {})).rejects.toMatchObject({
      code: RpcErrorCode.Unavailable,
    });
    expect(await a.room.notify("x", "sessions.update", { watchId: "w" } as never)).toBe(false);
    expect(relay.kept).toEqual([]);
  });
});

describe("what goes in a frame", () => {
  test("an answer too large to send comes back as an error, not as nothing", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key, {
      serve: async () => ({
        workspaces: [{ id: "w1", name: "x".repeat(MAX_MESSAGE_BYTES), path: "/ws" }],
        sessions: [],
      }),
    });
    a.room.start();
    b.room.start();
    await flushRelay();
    const failure = await a.room.request("b", "sessions.list", {}).catch((e: RpcFailure) => e);
    expect(failure).toMatchObject({ code: RpcErrorCode.InternalError });
    expect((failure as RpcFailure).message).toContain("too large");
  });

  test("a request too large to send fails at once", async () => {
    const relay = new MockRelay();
    const a = device(relay, "a", await roomKey());
    a.room.start();
    await expect(
      a.room.request("b", "chat.send", {
        workspaceId: "w",
        tabId: "t",
        text: "x".repeat(MAX_MESSAGE_BYTES),
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  });

  test("a notification of the protocol reaches the device told; another is dropped", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const told: [string, string, unknown][] = [];
    const a = device(relay, "a", key);
    const b = device(relay, "b", key, {
      onNotification: (from, method, params) => told.push([from, method, params]),
    });
    a.room.start();
    b.room.start();
    await flushRelay();
    const update = {
      watchId: "w1",
      rev: 1,
      total: 0,
      items: [],
      tools: {},
      tasks: {},
      agentItems: {},
    };
    expect(await a.room.notify("b", "chat.update", update)).toBe(true);
    expect(await a.room.notify("b", "chat.update", { ...update, rev: 0 } as never)).toBe(true);
    expect(
      await a.room.notify("b", "chat.update", {
        ...update,
        items: [
          { index: 0, item: { kind: "shell", key: "k", command: "x".repeat(MAX_MESSAGE_BYTES) } },
        ],
      }),
    ).toBe(false);
    await flushRelay();
    expect(told).toEqual([["a", "chat.update", update]]);
  });

  test("queued watch notifications keep every delta and only the latest session list", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const told: [string, unknown][] = [];
    const a = device(relay, "a", key);
    const b = device(relay, "b", key, {
      onNotification: (_from, method, params) => told.push([method, params]),
    });
    a.room.start();
    b.room.start();
    try {
      await flushRelay();
      const chat = {
        watchId: "chat",
        rev: 1,
        total: 0,
        items: [],
        tools: {},
        tasks: {},
        agentItems: {},
      };
      const terminal = { watchId: "terminal", rev: 1, start: 0, text: "$ " };
      const sessions = { watchId: "sessions", workspaces: [], sessions: [] };
      const nextChat = { ...chat, rev: 2 };
      const nextTerminal = { ...terminal, rev: 2, start: 2, text: "ls" };
      const nextSessions = {
        ...sessions,
        workspaces: [{ id: "w1", name: "app", path: "/app" }],
      };
      const sent = await Promise.all([
        a.room.notify("b", "chat.update", chat),
        a.room.notify("b", "terminal.update", terminal),
        a.room.notify("b", "sessions.update", sessions),
        a.room.notify("b", "chat.update", nextChat),
        a.room.notify("b", "terminal.update", nextTerminal),
        a.room.notify("b", "sessions.update", nextSessions),
      ]);
      expect(sent).toEqual([true, true, false, true, true, true]);
      await flushRelay();
      expect(told).toEqual([
        ["chat.update", chat],
        ["terminal.update", terminal],
        ["chat.update", nextChat],
        ["terminal.update", nextTerminal],
        ["sessions.update", nextSessions],
      ]);
    } finally {
      a.room.stop();
      b.room.stop();
    }
  });
});

describe("the protocol a device speaks", () => {
  test("a version at or past the one asked; none told is older", async () => {
    const { speaks } = await import("../../../../../src/shared/remote/room");
    expect(speaks("0.12.0", "0.12.0")).toBe(true);
    expect(speaks("0.12.3", "0.12.0")).toBe(true);
    expect(speaks("1.0.0", "0.12.0")).toBe(true);
    expect(speaks("0.11.9", "0.12.0")).toBe(false);
    expect(speaks("0.9.0", "0.12.0")).toBe(false);
    expect(speaks(undefined, "0.12.0")).toBe(false);
  });
});

describe("the host's file reads", () => {
  const read = (path: string) => ({ workspaceId: "w", path, as: "bytes" as const, length: 1 });
  const answered = { kind: "bytes", path: "/w/f", offset: 0, size: 1, data: "QQ==" } as const;

  test("one over the budget is told it is busy each, and the rest are read within the budget", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let active = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = device(relay, "host", key, {
      serves: ["files"],
      requestTimeoutMs: 5000,
      serve: async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return answered;
      },
    });
    const client = device(relay, "client", key, { requestTimeoutMs: 5000 });
    const otherHost = device(relay, "other-host", key, {
      serves: ["files"],
      serve: async () => answered,
    });
    host.room.start();
    otherHost.room.start();
    client.room.start();
    try {
      await flushRelay();
      // 8 reading, 32 waiting; the five after those are refused.
      const requests = Array.from({ length: 45 }, (_, i) =>
        client.room.request("host", "files.read", read(`/w/${i}`)).then(
          () => "read" as const,
          (e: RpcFailure) => e,
        ),
      );
      const refused = await Promise.all(requests.slice(40));
      // The first host still holds all its slots. A second host has its own budget.
      for (const failure of refused) {
        expect(failure).toMatchObject({
          code: RpcErrorCode.Unavailable,
          message: expect.stringContaining("busy"),
        });
      }
      expect(await client.room.request("other-host", "files.read", read("/w/f"))).toEqual(answered);
      release();
      const rest = await Promise.all(requests.slice(0, 40));
      expect(rest.every((outcome) => outcome === "read")).toBe(true);
      expect(peak).toBe(8);
    } finally {
      release();
      client.room.stop();
      otherHost.room.stop();
      host.room.stop();
    }
  });

  test("a read waits for a backed-up socket to drain before the host answers it", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let buffered = 1 << 30;
    const checkedSocket = Promise.withResolvers<void>();
    let served = 0;
    const host = device(relay, "host", key, {
      serves: ["files"],
      requestTimeoutMs: 5000,
      serve: async () => {
        served++;
        return answered;
      },
      connect: (handlers) => {
        const connection = relay.connection(
          { id: "host", name: "host-pc", platform: "darwin" },
          handlers,
        );
        return Object.defineProperty(connection, "bufferedAmount", {
          get: () => {
            checkedSocket.resolve();
            return buffered;
          },
        });
      },
    });
    const client = device(relay, "client", key, { requestTimeoutMs: 5000 });
    host.room.start();
    client.room.start();
    try {
      await flushRelay();
      const pending = client.room.request("host", "files.read", read("/w/f"));
      await checkedSocket.promise;
      expect(served).toBe(0);
      buffered = 0;
      // `.resolves` here hung Bun 1.4.4 on Windows past the test timeout; a plain await does not.
      expect(await pending).toMatchObject({ kind: "bytes" });
      expect(served).toBe(1);
    } finally {
      client.room.stop();
      host.room.stop();
    }
  });

  test("a read queued for a device that went away is dropped and does not hold the budget", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let served = 0;
    const filled = Promise.withResolvers<void>();
    const host = device(relay, "host", key, {
      serves: ["files"],
      requestTimeoutMs: 5000,
      serve: async () => {
        if (++served === 8) filled.resolve();
        await gate;
        return answered;
      },
    });
    const leaving = device(relay, "leaving", key, { requestTimeoutMs: 5000 });
    const staying = device(relay, "staying", key, { requestTimeoutMs: 5000 });
    host.room.start();
    leaving.room.start();
    staying.room.start();
    try {
      await flushRelay();
      // Fill the 8 reads, then queue one from a device that leaves.
      const holding = Array.from({ length: 8 }, (_, i) =>
        staying.room.request("host", "files.read", read(`/w/${i}`)).catch(() => null),
      );
      await filled.promise;
      const lost = leaving.room.request("host", "files.read", read("/w/gone")).catch(() => null);
      // This request uses the same inbox without waiting on the file read budget.
      await expect(leaving.room.request("host", "sessions.list", {})).rejects.toMatchObject({
        code: RpcErrorCode.Forbidden,
      });
      leaving.room.stop();
      await lost;
      release();
      await Promise.all(holding);
      await staying.room.request("host", "files.read", read("/w/after"));
      expect(served).toBe(9);
    } finally {
      release();
      leaving.room.stop();
      staying.room.stop();
      host.room.stop();
    }
  });
});

test("peer cache transfer through sealed room requests on open, reopen and same-size edit", async () => {
  const relay = new MockRelay();
  const key = await roomKey();
  const peer = { deviceId: "host", workspaceId: "workspace" };
  const path = "/workspace/sample.txt";
  const bytes = Buffer.alloc(MAX_BYTES_CHUNK * 2 + 25, 65);
  let revision = "v1";
  let contentBytes = 0;
  const host = device(relay, peer.deviceId, key, {
    serves: ["files"],
    serve: async ({ params }) => {
      const args = params as RpcParams<"files.read">;
      if (args.ifVersion === revision) return { kind: "notModified", version: revision };
      if (args.requireVersion && args.requireVersion !== revision)
        throw new RpcFailure(RpcErrorCode.InvalidParams, "file version changed");
      const offset = args.offset ?? 0;
      const data = bytes.subarray(offset, offset + (args.length ?? MAX_BYTES_CHUNK));
      contentBytes += data.length;
      return {
        kind: "bytes",
        path,
        offset,
        size: bytes.length,
        data: data.toString("base64"),
        version: revision,
      };
    },
  });
  const client = device(relay, "client", key, { onChange: (state) => cache.updateRoom(state) });
  const cache = new PeerFileReads((to, params, signal) =>
    client.room.request(to, "files.read", params, undefined, signal),
  );
  host.room.start();
  client.room.start();
  try {
    await flushRelay();
    const measure = async () => {
      const requests = relay.between("client", "host").length;
      const responses = relay.between("host", "client").length;
      const priorBytes = contentBytes;
      const got = await cache.readBytes(peer, path, 0, MAX_BYTES_CHUNK, true);
      const frames = relay.between("host", "client").slice(responses);
      return {
        requests: relay.between("client", "host").length - requests,
        contentBytes: contentBytes - priorBytes,
        replyFrameBytes: frames.reduce(
          (sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)),
          0,
        ),
        first: Buffer.from(got.parts[0] ?? "", "base64")[0],
      };
    };
    const first = await measure();
    const reopen = await measure();
    bytes.fill(66);
    revision = "v2";
    const changed = await measure();
    expect(first).toMatchObject({ requests: 3, contentBytes: bytes.length, first: 65 });
    expect(reopen).toMatchObject({ requests: 1, contentBytes: 0, first: 65 });
    expect(changed).toMatchObject({ requests: 3, contentBytes: bytes.length, first: 66 });
    expect(reopen.replyFrameBytes).toBeLessThan(500);
    expect(first.replyFrameBytes).toBeGreaterThan(bytes.length);
    console.info("peer file transfer (sealed in-memory relay)", { first, reopen, changed });
  } finally {
    client.room.stop();
    host.room.stop();
  }
});

test("CLI-only writes with a missing or denied sender never reach a mutation", async () => {
  const relay = new MockRelay();
  const key = await roomKey();
  const mutations: string[] = [];
  const app = fakeApp(0);
  const workspaceId = app.services.listWorkspaces()[0]?.id ?? "";
  const host = device(relay, "host", key, {
    serves: ["agents", "agents.cli", "chat.control"],
    serve: serveWith(
      () => ({
        ...app.services,
        ui: async (op) => {
          mutations.push(op);
          throw new Error("unexpected call");
        },
      }),
      { agents: new AgentGate({ policy: () => "deny" }) },
    ),
  }).room;
  const peer = device(relay, "peer", key).room;
  host.start();
  peer.start();
  try {
    await flushRelay();
    const params = { workspaceId, force: true, deleteBranch: false };
    await expect(peer.request("host", "worktree.remove", params as never)).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
    await expect(
      peer.request("host", "worktree.remove", {
        ...params,
        from: { kind: "tab", workspaceId: "other", tabId: "caller" },
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(mutations).toEqual([]);
  } finally {
    host.stop();
    peer.stop();
  }
});

test("serves persistent instruction previews as agent reads under the receiving policy", async () => {
  const relay = new MockRelay();
  const key = await roomKey();
  const app = fakeApp();
  const workspaceId = app.workspaces[0]!.id;
  const preview = {
    layers: [{ scope: { kind: "profile", id: "work" }, title: "Profile: Work", text: "Use bun." }],
    instructions: "## Profile: Work\nUse bun.",
  };
  app.uiAnswers.set("settings.instructions", preview);
  let allowAgents = true;
  let denyPolicy = false;
  const host = device(relay, "host", key, {
    serves: () => servesWith(false, false, allowAgents),
    serve: serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => (denyPolicy ? "deny" : "ask") }),
    }),
  }).room;
  const peer = device(relay, "peer", key).room;
  host.start();
  peer.start();
  try {
    await flushRelay();
    expect(peer.state().peers[0]?.serves).toContain("settings.instructions");
    const target = { workspaceId, agent: "codex" as const, profileId: "work" };
    const params = { ...target, from: { kind: "tab" as const, workspaceId: "other", tabId: "t" } };
    const read = () => peer.request("host", "settings.instructions", params);
    await expect(read()).resolves.toEqual(preview);
    denyPolicy = true;
    await expect(read()).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    denyPolicy = false;
    allowAgents = false;
    await expect(read()).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(app.uiCalls).toEqual([{ op: "settings.instructions", args: target }]);
    expect(app.asked).toEqual([]);
  } finally {
    host.stop();
    peer.stop();
  }
});

test("profile instruction writes pin the profile id and need a fresh approval", async () => {
  const relay = new MockRelay();
  const key = await roomKey();
  const app = fakeApp();
  const workspaceId = app.workspaces[0]!.id;
  const profile = { id: "work", name: "Work", agent: "codex", isDefault: false };
  app.uiAnswers.set("chat.profiles", { profiles: [profile] });
  app.uiAnswers.set("settings.instructions.set", {});
  app.uiAnswers.set("consent.ask", { answer: "once" });
  const host = device(relay, "host", key, {
    serves: servesWith(true, false, true),
    serve: serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => "allow" }),
    }),
  }).room;
  const peer = device(relay, "peer", key).room;
  host.start();
  peer.start();
  try {
    await flushRelay();
    const set = (profileId: string, text: string) =>
      peer.request("host", "settings.instructions.set", {
        workspaceId,
        layer: "profile",
        profileId,
        text,
        from: { kind: "tab", workspaceId: "other", tabId: "t" },
      });
    await expect(set("missing", "Use bun.")).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
    await expect(set(profile.id, "Use bun.")).resolves.toEqual({});
    app.uiAnswers.set("consent.ask", { answer: "session" });
    await expect(set(profile.id, "")).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(app.uiCalls.filter(({ op }) => op === "consent.ask").map(({ args }) => args)).toEqual(
      ["Use bun.", "Clear this layer"].map((body) =>
        expect.objectContaining({
          change: {
            kind: "instructionsEdit",
            body,
            detail: 'codex profile "Work" (work)',
            eachTime: true,
          },
        }),
      ),
    );
    expect(app.uiCalls.filter(({ op }) => op === "settings.instructions.set")).toEqual([
      {
        op: "settings.instructions.set",
        args: { scope: { kind: "profile", id: profile.id }, text: "Use bun." },
      },
    ]);
  } finally {
    host.stop();
    peer.stop();
  }
});

test("phones can edit chat instructions with chat control and agents still need consent", async () => {
  const relay = new MockRelay();
  const key = await roomKey();
  const app = fakeApp();
  const workspaceId = app.workspaces[0]!.id;
  const tab = { workspaceId, tabId: "chat" };
  app.tabs[workspaceId]?.push({
    id: tab.tabId,
    type: "claude",
    title: "Review",
    groupId: "g1",
    shown: true,
  });
  const layers = [{ scope: { kind: "all" }, title: "All agents", text: "" }];
  let session = "";
  app.uiAnswers.set("chat.instructions", ({ text }: { text?: string }) => {
    if (text !== undefined) session = text;
    return { instructions: session, session, layers };
  });
  let chat = false;
  let agents = false;
  const host = device(relay, "host", key, {
    serves: () => servesWith(chat, false, agents),
    serve: serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => "ask" }),
    }),
  }).room;
  const phone = device(relay, "phone", key, {
    self: { id: "phone", name: "Phone", platform: "ios" },
  }).room;
  const peer = device(relay, "peer", key).room;
  host.start();
  phone.start();
  peer.start();
  try {
    await flushRelay();
    const read = () => phone.request("host", "chat.instructions", tab);
    const write = (text: string) =>
      phone.request("host", "chat.instructions.set", { ...tab, text });
    await expect(read()).resolves.toEqual({ instructions: "", session: "", layers });
    await expect(write("Phone rules")).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    chat = true;
    await expect(write("a".repeat(5001))).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
    await expect(write("Phone rules")).resolves.toEqual({ instructions: "Phone rules" });
    await expect(read()).resolves.toEqual({
      instructions: "Phone rules",
      session: "Phone rules",
      layers,
    });
    expect(app.uiCalls.some(({ op }) => op === "consent.ask")).toBe(false);

    agents = true;
    const from = { kind: "tab" as const, workspaceId: "other", tabId: "t" };
    const writeAsAgent = () =>
      peer.request("host", "chat.instructions.set", { ...tab, text: "Agent rules", from });
    app.uiAnswers.set("consent.ask", { answer: "deny" });
    await expect(writeAsAgent()).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(session).toBe("Phone rules");
    app.uiAnswers.set("consent.ask", { answer: "once" });
    await expect(writeAsAgent()).resolves.toEqual({ instructions: "Agent rules" });
    await expect(write("")).resolves.toEqual({ instructions: "" });
    expect(app.uiCalls.filter(({ op }) => op === "consent.ask").map(({ args }) => args)).toEqual(
      Array.from({ length: 2 }, () =>
        expect.objectContaining({
          toWorkspaceId: workspaceId,
          change: { kind: "chatSettings", detail: "Review", body: "Agent rules" },
        }),
      ),
    );
  } finally {
    host.stop();
    phone.stop();
    peer.stop();
  }
});

test("serves file transfers by scope and cleans pending uploads when the sending peer disconnects", async () => {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "nexus-transfer-room-")));
  const root = path.join(tmp, "workspace");
  const outside = path.join(tmp, "outside.txt");
  await mkdir(root);
  await writeFile(outside, "outside");
  const relay = new MockRelay();
  const key = await roomKey();
  const app = fakeApp();
  const workspace = app.workspaces[0];
  if (!workspace) throw new Error("workspace fixture is missing");
  const location = { kind: "local" as const, rootPath: root };
  Object.assign(workspace, { rootPath: root, location });
  const fs = {
    kind: "local",
    readdirNoLinks: async ({ absolutePath }: { absolutePath: string }) => {
      expect(absolutePath).toBe(tmp);
      return [];
    },
    readPreview: async ({ absolutePath }: { absolutePath: string }) => {
      expect(absolutePath).toBe(outside);
      const bytes = await readFile(absolutePath);
      return { kind: "content", base64: bytes.toString("base64"), sizeBytes: bytes.length };
    },
  } as unknown as FsProvider;
  let chat = false;
  let terminal = false;
  let allowAgents = true;
  const fileWrites = new FileWrites();
  let cleanup: Promise<void> | undefined;
  const host = device(relay, "host", key, {
    serves: () => servesWith(chat, terminal, allowAgents),
    serve: serveWith(() => app.services, {
      agents: new AgentGate({ policy: () => (allowAgents ? "allow" : "deny") }),
      controls: () => ({ chat, terminal }),
      fileWrites,
      files: { fs: async () => fs, shrink: () => null },
    }),
    onDisconnect: (peer) => {
      cleanup = fileWrites.drop(peer);
    },
  }).room;
  const peer = device(relay, "peer", key).room;
  host.start();
  peer.start();
  try {
    await flushRelay();
    const from = { kind: "tab" as const, workspaceId: "pw", tabId: "pt" };
    const scoped = { workspaceId: workspace.id, path: "data", size: 0, from };
    const absolute = { ...scoped, path: outside, anywhere: true as const };
    const outsideRead = { workspaceId: workspace.id, path: outside, from, anywhere: true as const };
    await expect(peer.request("host", "files.write.begin", scoped)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    await expect(peer.request("host", "files.read", outsideRead)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    await expect(peer.request("host", "files.write.begin", absolute)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    terminal = true;
    const { uploadId } = await peer.request("host", "files.write.begin", absolute);
    const sha256 = createHash("sha256").digest("hex");
    terminal = false;
    await expect(
      peer.request("host", "files.write.end", { uploadId, sha256 }),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    terminal = true;
    await expect(peer.request("host", "files.read", outsideRead)).resolves.toMatchObject({
      path: outside,
      text: "outside",
    });
    await expect(
      peer.request("host", "files.list", { ...outsideRead, path: tmp }),
    ).resolves.toMatchObject({ path: tmp });
    allowAgents = false;
    await expect(peer.request("host", "files.read", outsideRead)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    await expect(peer.request("host", "files.write.begin", absolute)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
    allowAgents = true;
    chat = true;
    await peer.request("host", "files.mkdir", { workspaceId: workspace.id, path: "folder", from });
    await peer.request("host", "files.write.begin", scoped);
    expect(await readdir(root)).toHaveLength(2);
    peer.stop();
    await cleanup;
    expect(await readdir(root)).toEqual(["folder"]);
    expect((await readdir(tmp)).sort()).toEqual(["outside.txt", "workspace"]);
    expect(app.asked).toEqual([]);
  } finally {
    peer.stop();
    host.stop();
    await fileWrites.drop();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the 0.14 file schemas preserve 0.13 requests and tolerate old readers stripping scope", () => {
  const request = {
    workspaceId: "w",
    path: "/outside",
    as: "bytes" as const,
    offset: 0,
    length: 64,
  };
  const currentRead = RPC_METHODS["files.read"].params;
  const oldRead = currentRead.omit({ anywhere: true, from: true, transferId: true });
  expect(currentRead.parse(request)).toEqual(request);
  expect(oldRead.parse({ ...request, anywhere: true })).toEqual(request);
  const currentList = RPC_METHODS["files.list"].params;
  const oldList = currentList.omit({
    anywhere: true,
    from: true,
    transferId: true,
    writeTarget: true,
  });
  const list = { workspaceId: "w", path: "." };
  expect(currentList.parse(list)).toEqual(list);
  expect(oldList.parse({ ...list, anywhere: true })).toEqual(list);
});
