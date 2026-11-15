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
