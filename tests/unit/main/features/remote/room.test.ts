/** Devices of one account in a room, through an in-memory relay. */
import { describe, expect, test } from "bun:test";
import type {
  ClientFrame,
  RoomDevice,
  ServerFrame,
} from "../../../../../packages/remote-protocol/src";
import { RpcErrorCode } from "../../../../../packages/remote-protocol/src";
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
      const delivered: ServerFrame = { ...frame, t: "message", from };
      this.online.get(id)?.onFrame(this.tamper ? this.tamper(delivered) : delivered);
    }
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
  const room = new RemoteRoom({
    self,
    room: key,
    app: { name: "NexusCode", version: "0.0.0-test" },
    serves: ["sessions"],
    connect: (handlers) => relay.connection(self, handlers),
    serve: async ({ from, method }) => {
      served.push({ from, method });
      return { workspaces: [{ id: "w1", name: "ws", path: "/ws" }], sessions: [] };
    },
    onChange: () => {},
    onSignedOut: () => {},
    requestTimeoutMs: 300,
    ...extra,
  });
  return { room, served };
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

  test("a message sealed with another key version is told, and not opened", async () => {
    const relay = new MockRelay();
    const foreign: number[] = [];
    const a = device(relay, "a", await roomKey(), { onForeignKey: (kid) => foreign.push(kid) });
    const b = device(relay, "b", { kid: 2, key: roomKeyOf(await newAccountKey()) });
    a.room.start();
    b.room.start();
    await tick();
    expect(foreign).toContain(2);
    expect(a.room.state().peers[0]?.serves).toBeUndefined();
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
