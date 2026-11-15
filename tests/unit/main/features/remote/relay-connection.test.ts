/** The relay's socket: a socket that never opened says what it went to was not reached. */
import { expect, test } from "bun:test";
import { RelayConnection } from "../../../../../src/main/features/remote/relay-connection";

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
