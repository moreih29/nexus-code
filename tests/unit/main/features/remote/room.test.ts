/** Devices of one account in a room, through an in-memory relay. */
import { describe, expect, test } from "bun:test";
import type {
  ClientFrame,
  Delivered,
  RoomDevice,
  ServerFrame,
} from "../../../../../packages/remote-protocol/src";
import { RpcErrorCode, SCHEMA_VERSION } from "../../../../../packages/remote-protocol/src";
import { newAccountKey, roomKeyOf } from "../../../../../src/main/features/remote/account-key";
import type { RelayConnectionDeps } from "../../../../../src/main/features/remote/relay-connection";
import {
  MAX_MESSAGE_BYTES,
  RemoteRoom,
  type RemoteRoomDeps,
  RpcFailure,
} from "../../../../../src/main/features/remote/room";
import type { RoomKey } from "../../../../../src/main/features/remote/seal";

type Handlers = Pick<RelayConnectionDeps, "onOpen" | "onFrame" | "onStatus" | "onSignedOut">;

/** The relay, as the contract has it: stamps `from`, routes, tells who is in. */
class MockRelay {
  readonly devices: RoomDevice[] = [];
  private readonly online = new Map<string, Handlers>();
  /** Changes a frame on its way, as a relay that cheats would. */
  tamper: ((frame: ServerFrame) => ServerFrame) | null = null;
  /** Every message it passed on, as it delivered it: a relay that cheats may send one again. */
  readonly kept: { to: string; frame: Delivered }[] = [];

  connection(device: Omit<RoomDevice, "online">, handlers: Handlers) {
    if (!this.devices.some((d) => d.id === device.id))
      this.devices.push({ ...device, online: false });
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
      send: (frame: ClientFrame) => {
        queueMicrotask(() => this.route(device.id, frame));
        return true;
      },
    };
  }

  private route(from: string, frame: ClientFrame) {
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

const tick = () => new Promise((r) => setTimeout(r, 20));

async function roomKey(): Promise<RoomKey> {
  return { kid: 1, key: roomKeyOf(await newAccountKey()) };
}

function device(relay: MockRelay, id: string, key: RoomKey, extra: Partial<RemoteRoomDeps> = {}) {
  const self = { id, name: `${id}-pc`, platform: "darwin" };
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
  return { room, served, reopen: () => connection?.reopen() };
}

describe("the room", () => {
  test("devices say hello, see each other, and answer each other's requests", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await tick();
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

  test("refuses what it does not serve, and params not of the protocol", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await tick();
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
    await tick();
    const tab = { workspaceId: "w1", tabId: "t1" };
    const from = { kind: "tab" as const, workspaceId: "bw", tabId: "bt", hops: 1 };
    // People may control the chats; agents may not.
    await expect(b.room.request("a", "chat.interrupt", { ...tab, from })).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
      message: expect.stringContaining("control by agents is off"),
    });
    expect(a.served).toEqual([]);
    // Agents may; people may not.
    serves = ["sessions", "agents"];
    a.room.announce();
    await tick();
    await b.room.request("a", "chat.interrupt", { ...tab, from });
    expect(a.served).toEqual([{ from: "b", method: "chat.interrupt" }]);
    await expect(b.room.request("a", "chat.interrupt", tab)).rejects.toMatchObject({
      code: RpcErrorCode.Forbidden,
    });
  });

  test("an agent's request to a method that takes none from agents is refused, not taken as the user's", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key, { serves: () => ["sessions", "chat.control", "agents"] });
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await tick();
    const from = { kind: "tab" as const, workspaceId: "bw", tabId: "bt", hops: 1 };
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
    await tick();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions", "chat.control"]);
    control = false;
    a.room.announce();
    await tick();
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
    await tick();
    expect(b.room.state().peers[0]?.app).toEqual({
      name: "NexusCode",
      version: "0.0.0-test",
      theme: "github-dark",
    });
    // One that tells none says none.
    expect(a.room.state().peers[0]?.app).toEqual({ name: "NexusCode", version: "0.0.0-test" });
    theme = "github-light";
    a.room.announce();
    await tick();
    expect(b.room.state().peers[0]?.app.theme).toBe("github-light");
  });

  test("a device that left is told as unavailable", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key);
    const b = device(relay, "b", key);
    a.room.start();
    b.room.start();
    await tick();
    a.room.stop();
    await tick();
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
    await tick();
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
    await tick();
    for (const frame of relay.between("b", "a")) relay.deliver("a", frame);
    await tick();
    expect(foreign).toEqual([2]);
    expect(a.room.state().peers[0]?.serves).toBeUndefined();
    // An older version is no reset: the key is not fetched for it.
    for (const frame of relay.between("a", "b")) relay.deliver("b", frame);
    await tick();
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
    await tick();
    return { relay, key, a, b };
  }

  test("a message sent again is not taken twice", async () => {
    const { relay, a, b } = await pair();
    await b.room.request("a", "sessions.list", {});
    for (const frame of relay.between("b", "a")) relay.deliver("a", frame);
    await tick();
    expect(a.served).toHaveLength(1);
  });

  test("a message of an earlier connection is not taken in a new one", async () => {
    const { relay, a, b } = await pair();
    await b.room.request("a", "sessions.list", {});
    const kept = relay.between("b", "a");
    // Days later, both connected again.
    a.reopen();
    b.reopen();
    await tick();
    for (const frame of kept) relay.deliver("a", frame);
    await tick();
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
    await tick();
    // Sealed for a's epoch, which has not changed, but in b's old one.
    for (const frame of kept) relay.deliver("a", frame);
    await tick();
    expect(a.served).toHaveLength(1);
    await b.room.request("a", "sessions.list", {});
    expect(a.served).toHaveLength(2);
  });

  test("a message for another device, passed on to this one, is not taken", async () => {
    const { relay, key, a, b } = await pair();
    const c = device(relay, "c", key);
    c.room.start();
    await tick();
    await b.room.request("a", "sessions.list", {});
    for (const frame of relay.between("b", "a")) {
      relay.deliver("c", frame);
      // Its `to` is sealed with it: changed, it does not open.
      relay.deliver("c", { ...frame, to: "c" });
    }
    await tick();
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
    await tick();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions", "chat.control"]);
    const kept = [...relay.between("a", "b")];
    serves = ["sessions"];
    a.room.announce();
    await tick();
    for (const frame of kept) relay.deliver("b", frame);
    await tick();
    expect(b.room.state().peers[0]?.serves).toEqual(["sessions"]);
  });

  test("what it asked before its connection dropped fails at once", async () => {
    const relay = new MockRelay();
    const key = await roomKey();
    const a = device(relay, "a", key, { serve: () => new Promise(() => {}) });
    const b = device(relay, "b", key, { requestTimeoutMs: 10_000 });
    a.room.start();
    b.room.start();
    await tick();
    const asked = b.room.request("a", "sessions.list", {});
    await tick();
    b.reopen();
    await expect(asked).rejects.toMatchObject({
      code: RpcErrorCode.Unavailable,
      message: "the connection to the room was lost",
    });
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
    await tick();
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
    await tick();
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
    await tick();
    expect(told).toEqual([["a", "chat.update", update]]);
  });
});
