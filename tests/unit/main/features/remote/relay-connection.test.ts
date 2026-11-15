/** The relay's socket: a socket that never opened says what it went to was not reached. */
import { expect, test } from "bun:test";
import { OutdatedError, UnreachableError } from "../../../../../src/main/features/remote/errors";
import {
  RelayConnection,
  type RelayStatus,
} from "../../../../../src/main/features/remote/relay-connection";

class FakeSocket {
  readyState = 0;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  send() {}
  close() {}
}

test("a socket closed before it opened is told as unreachable; one closed after is not", async () => {
  const sockets: FakeSocket[] = [];
  const unreachable: string[] = [];
  let n = 0;
  const relay = new RelayConnection({
    url: async () => `wss://proxy.example/relay?ticket=t${++n}`,
    onOpen: () => {},
    onFrame: () => {},
    onStatus: () => {},
    onSignedOut: () => {},
    unreachable: (url) => unreachable.push(url),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as never;
    },
    backoff: () => 0,
  });
  const next = async (count: number) => {
    for (let i = 0; i < 50 && sockets.length < count; i++) await Bun.sleep(1);
    const socket = sockets[count - 1];
    if (!socket) throw new Error("no socket");
    return socket;
  };
  relay.start();
  (await next(1)).emit("close", { code: 1006 });
  expect(unreachable).toEqual(["wss://proxy.example/relay?ticket=t1"]);
  const second = await next(2);
  second.emit("open");
  second.emit("close", { code: 1006 });
  expect(unreachable).toHaveLength(1);
  await next(3);
  relay.stop();
});

test("reconnect opens a new socket now; the old one's close is not taken for a loss", async () => {
  const sockets: FakeSocket[] = [];
  const unreachable: string[] = [];
  const relay = new RelayConnection({
    url: async () => "wss://nexus.example/relay?ticket=t",
    onOpen: () => {},
    onFrame: () => {},
    onStatus: () => {},
    onSignedOut: () => {},
    unreachable: (url) => unreachable.push(url),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as never;
    },
    backoff: () => 60_000,
  });
  const settle = async (count: number) => {
    for (let i = 0; i < 50 && sockets.length < count; i++) await Bun.sleep(1);
  };
  relay.start();
  await settle(1);
  sockets[0]?.emit("open");
  relay.reconnect();
  await settle(2);
  expect(sockets).toHaveLength(2);
  sockets[0]?.emit("close", { code: 1000 });
  await Bun.sleep(5);
  expect([sockets.length, unreachable]).toEqual([2, []]);
  relay.stop();
  relay.reconnect();
  await Bun.sleep(5);
  expect(sockets).toHaveLength(2);
});

test("a ticket that says the app is too old gives up: no socket, no retry, not signed out", async () => {
  const statuses: RelayStatus[] = [];
  let asked = 0;
  let signedOut = false;
  const relay = new RelayConnection({
    url: async () => {
      asked += 1;
      throw new OutdatedError();
    },
    onOpen: () => {},
    onFrame: () => {},
    onStatus: (status) => statuses.push(status),
    onSignedOut: () => {
      signedOut = true;
    },
    socket: () => {
      throw new Error("no socket should open");
    },
    backoff: () => 0,
  });
  relay.start();
  for (let i = 0; i < 20; i++) await Bun.sleep(1);
  expect(statuses).toEqual(["connecting", "outdated"]);
  expect(asked).toBe(1);
  expect(signedOut).toBe(false);
  // Asked to go another way, it stays out: only an update brings it back.
  relay.reconnect();
  for (let i = 0; i < 5; i++) await Bun.sleep(1);
  expect(asked).toBe(1);
});

test("any other failure to get a ticket waits and tries again", async () => {
  const statuses: RelayStatus[] = [];
  let asked = 0;
  const relay = new RelayConnection({
    url: async () => {
      asked += 1;
      throw new UnreachableError(new TypeError("fetch failed"));
    },
    onOpen: () => {},
    onFrame: () => {},
    onStatus: (status) => statuses.push(status),
    onSignedOut: () => {},
    backoff: () => 0,
  });
  relay.start();
  for (let i = 0; i < 50 && asked < 3; i++) await Bun.sleep(1);
  relay.stop();
  expect(asked).toBeGreaterThanOrEqual(3);
  expect(statuses.slice(0, 3)).toEqual(["connecting", "waiting", "connecting"]);
});

test("lost from the room, it comes back at once; lost again within 30 s, it waits", async () => {
  const sockets: FakeSocket[] = [];
  const statuses: RelayStatus[] = [];
  let now = 1_000_000;
  const relay = new RelayConnection({
    url: async () => "wss://nexus.example/relay?ticket=t",
    onOpen: () => {},
    onFrame: () => {},
    onStatus: (status) => statuses.push(status),
    onSignedOut: () => {},
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as never;
    },
    // Any wait would outlast the test: only a try at once opens another socket.
    backoff: () => 60_000,
    now: () => now,
  });
  const next = async (count: number) => {
    for (let i = 0; i < 50 && sockets.length < count; i++) await Bun.sleep(1);
    return sockets[count - 1];
  };
  relay.start();
  const first = await next(1);
  first?.emit("open");
  first?.emit("close", { code: 1012 });
  const second = await next(2);
  expect(second).toBeDefined();
  expect(statuses).not.toContain("waiting");
  // Lost again 10 s later: it waits its backoff.
  now += 10_000;
  second?.emit("open");
  second?.emit("close", { code: 1006 });
  await Bun.sleep(5);
  expect(sockets).toHaveLength(2);
  expect(statuses.at(-1)).toBe("waiting");
  relay.stop();
});

test("a socket that never opened does not try again at once", async () => {
  const sockets: FakeSocket[] = [];
  const relay = new RelayConnection({
    url: async () => "wss://nexus.example/relay?ticket=t",
    onOpen: () => {},
    onFrame: () => {},
    onStatus: () => {},
    onSignedOut: () => {},
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as never;
    },
    backoff: () => 60_000,
  });
  relay.start();
  for (let i = 0; i < 50 && sockets.length < 1; i++) await Bun.sleep(1);
  sockets[0]?.emit("close", { code: 1006 });
  await Bun.sleep(5);
  expect(sockets).toHaveLength(1);
  relay.stop();
});
