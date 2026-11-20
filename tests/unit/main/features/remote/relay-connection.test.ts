/** The relay's socket: a socket that never opened says what it went to was not reached. */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  OutdatedError,
  SignedOutError,
  UnreachableError,
} from "../../../../../src/main/features/remote/errors";
import {
  CLOSE_FLOODING,
  CLOSE_REPLACED,
  CLOSE_SIGNED_OUT,
  RELAY_PING,
  RELAY_PONG,
  RelayConnection,
  type RelayStatus,
  SEND_BUFFER_STALL_MS,
  SOCKET_OPEN_TIMEOUT_MS,
} from "../../../../../src/main/features/remote/relay-connection";
import { returnToProxy, ServerRoute } from "../../../../../src/main/features/remote/route";
import { mainInfoMock, mainWarnMock } from "../../../../log-test-spies";

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: object = {}) {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  readonly sent: string[] = [];
  readonly closes: [number | undefined, string | undefined][] = [];
  closed = false;
  send(text: string) {
    this.sent.push(text);
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
    this.closed = true;
    this.readyState = 2;
  }
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

describe("relay ticket ownership", () => {
  const firstUrl = "wss://nexus.example/relay?ticket=old";
  const nextUrl = "wss://proxy.example/relay?ticket=new";

  /** Controls which ticket completes first and records every allocated socket. */
  function harness() {
    const first = Promise.withResolvers<string>();
    const next = Promise.withResolvers<string>();
    const tickets = [first, next];
    const sockets: FakeSocket[] = [];
    const statuses: RelayStatus[] = [];
    const signedOut = jest.fn();
    const url = jest.fn(() => {
      const ticket = tickets.shift();
      if (!ticket) throw new Error("unexpected ticket request");
      return ticket.promise;
    });
    const relay = new RelayConnection({
      url,
      onOpen: () => {},
      onFrame: () => {},
      onStatus: (status) => statuses.push(status),
      onSignedOut: signedOut,
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      backoff: () => 100,
    });
    relay.start();
    return { relay, first, next, url, sockets, statuses, signedOut };
  }

  afterEach(() => jest.useRealTimers());

  test.each([
    "first",
    "last",
  ] as const)("only opens the current socket when the stale ticket succeeds %s", async (order) => {
    jest.useFakeTimers();
    const { relay, first, next, sockets } = harness();
    try {
      relay.reconnect();
      if (order === "first") {
        first.resolve(firstUrl);
        await Promise.resolve();
        expect(sockets).toHaveLength(0);
      }
      next.resolve(nextUrl);
      await Promise.resolve();
      sockets[0]?.emit("open");
      if (order === "last") {
        first.resolve(firstUrl);
        await Promise.resolve();
      }
      expect(sockets.map((socket) => socket.url)).toEqual([nextUrl]);
    } finally {
      relay.stop();
    }
    expect(sockets.every((socket) => socket.closed)).toBe(true);
  });

  test.each([
    ["retry", () => new UnreachableError(new TypeError("unreachable"))],
    ["give up", () => new OutdatedError()],
    ["sign out", () => new SignedOutError()],
  ] as const)("a stale ticket cannot %s after the replacement is online", async (_action, error) => {
    jest.useFakeTimers();
    const { relay, first, next, url, sockets, statuses, signedOut } = harness();
    try {
      relay.reconnect();
      next.resolve(nextUrl);
      await Promise.resolve();
      sockets[0]?.emit("open");

      first.reject(error());
      await Promise.resolve();
      jest.advanceTimersByTime(100);

      expect(statuses).toEqual(["connecting", "online"]);
      expect(sockets.map((socket) => [socket.url, socket.closed])).toEqual([[nextUrl, false]]);
      expect(url).toHaveBeenCalledTimes(2);
      expect(signedOut).not.toHaveBeenCalled();
    } finally {
      relay.stop();
    }
  });

  test.each([
    [CLOSE_REPLACED, "replaced", 0],
    [CLOSE_SIGNED_OUT, "stopped", 1],
  ] as const)("current socket close %s still ends the relay", async (code, status, called) => {
    jest.useFakeTimers();
    const { relay, first, url, sockets, statuses, signedOut } = harness();
    try {
      first.resolve(firstUrl);
      await Promise.resolve();
      sockets[0]?.emit("open");
      const logsBefore = mainInfoMock.mock.calls.length;
      sockets[0]?.emit("close", { code });
      const logs = mainInfoMock.mock.calls.slice(logsBefore).map(([message]) => message);
      expect(logs).toContain(`Relay socket closed code=${code} opened=true`);
      expect(logs).toContain(`Relay state changed from=online to=${status}`);

      relay.reconnect();
      jest.advanceTimersByTime(60_000);
      expect(statuses).toEqual(["connecting", "online", status]);
      expect(url).toHaveBeenCalledTimes(1);
      expect(signedOut).toHaveBeenCalledTimes(called);
    } finally {
      relay.stop();
    }
  });

  test("a ticket from before stop cannot open a socket after start", async () => {
    jest.useFakeTimers();
    const { relay, first, next, sockets } = harness();
    try {
      relay.stop();
      relay.start();
      first.resolve(firstUrl);
      await Promise.resolve();
      expect(sockets).toHaveLength(0);
      next.resolve(nextUrl);
      await Promise.resolve();
      expect(sockets.map((socket) => socket.url)).toEqual([nextUrl]);
    } finally {
      relay.stop();
    }
  });

  test("a stop during the connecting notification prevents asking for a ticket", () => {
    const url = jest.fn(async () => firstUrl);
    const relay = new RelayConnection({
      url,
      onOpen: () => {},
      onFrame: () => {},
      onStatus: (status) => {
        if (status === "connecting") relay.stop();
      },
      onSignedOut: () => {},
    });
    relay.start();
    expect(url).not.toHaveBeenCalled();
  });
});

test("a proxy probe completing during automatic reconnect leaves the pending ticket in charge", async () => {
  const ticket = Promise.withResolvers<string>();
  const response = Promise.withResolvers<Response>();
  const sockets: FakeSocket[] = [];
  const url = jest.fn(() =>
    sockets.length === 0
      ? Promise.resolve("wss://nexus.example/relay?ticket=direct")
      : ticket.promise,
  );
  const relay = new RelayConnection({
    url,
    onOpen: () => {},
    onFrame: () => {},
    onStatus: () => {},
    onSignedOut: () => {},
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const probe = returnToProxy({
    route: new ServerRoute("https://nexus.example", "https://proxy.example", () => 0),
    via: () => relay.onlineRoute(),
    reconnect: () => relay.reconnect(),
    fetch: (() => response.promise) as typeof fetch,
  });
  try {
    relay.start();
    await Promise.resolve();
    sockets[0]?.emit("open");
    const pending = probe.check();
    sockets[0]?.emit("close", { code: 1006 });
    expect(url).toHaveBeenCalledTimes(2);

    response.resolve(new Response("{}"));
    await pending;
    expect(url).toHaveBeenCalledTimes(2);
    ticket.resolve("wss://proxy.example/relay?ticket=recovered");
    await Promise.resolve();
    sockets[1]?.emit("open");
    expect(relay.onlineRoute()?.origin).toBe("wss://proxy.example");
    expect(sockets).toHaveLength(2);
  } finally {
    probe.stop();
    relay.stop();
  }
  expect(sockets[1]?.closed).toBe(true);
});

describe("the heartbeat", () => {
  const heartbeat = { every: 25, wait: 15 };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Opens the connection before advancing the heartbeat clock. */
  async function open(timing = heartbeat) {
    const sockets: FakeSocket[] = [];
    const frames: unknown[] = [];
    const statuses: RelayStatus[] = [];
    const relay = new RelayConnection({
      url: async () => "wss://nexus.example/relay?ticket=t",
      onOpen: () => {},
      onFrame: (frame) => frames.push(frame),
      onStatus: (status) => statuses.push(status),
      onSignedOut: () => {},
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      backoff: () => 60_000,
      heartbeat: timing,
    });
    relay.start();
    await Promise.resolve();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.emit("open");
    return { relay, sockets, frames, statuses, socket };
  }

  test("an answered heartbeat keeps the socket, and the answer is no frame", async () => {
    const { relay, sockets, frames, socket } = await open();
    try {
      for (let beat = 0; beat < 3; beat++) {
        jest.advanceTimersByTime(heartbeat.every);
        expect(socket.sent[beat]).toBe(RELAY_PING);
        socket.emit("message", { data: RELAY_PONG });
      }
      expect([sockets.length, socket.closed, frames]).toEqual([1, false, []]);
    } finally {
      relay.stop();
    }
  });

  test("two consecutive misses reopen the socket with a diagnostic close reason", async () => {
    const { relay, sockets, statuses, socket } = await open();
    try {
      jest.advanceTimersByTime(heartbeat.every);
      expect(socket.sent).toEqual([RELAY_PING]);
      jest.advanceTimersByTime(heartbeat.wait - 1);
      expect(socket.closed).toBe(false);

      jest.advanceTimersByTime(1);
      expect(socket.closed).toBe(false);
      jest.advanceTimersByTime(heartbeat.every);
      await Promise.resolve();
      expect(socket.closed).toBe(true);
      expect(socket.closes).toEqual([[1000, "pong-timeout"]]);
      expect(sockets).toHaveLength(2);
      expect(statuses).not.toContain("waiting");

      // Its close may arrive after the next socket starts connecting.
      socket.emit("close", { code: 1006 });
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(sockets).toHaveLength(2);
    } finally {
      relay.stop();
    }
  });

  test("a pong received between misses clears the miss count", async () => {
    const { relay, socket } = await open();
    try {
      jest.advanceTimersByTime(heartbeat.every + heartbeat.wait);
      jest.advanceTimersByTime(heartbeat.every - heartbeat.wait);
      socket.emit("message", { data: RELAY_PONG });
      jest.advanceTimersByTime(heartbeat.every + heartbeat.wait);
      expect(socket.closed).toBe(false);
      jest.advanceTimersByTime(heartbeat.every);
      expect(socket.closes).toEqual([[1000, "pong-timeout"]]);
    } finally {
      relay.stop();
    }
  });

  test("a late pong timer leaves the socket open and gives a queued pong time to arrive", async () => {
    const { relay, socket } = await open();
    const now = performance.now.bind(performance);
    let slipMs = 0;
    const clock = jest.spyOn(performance, "now").mockImplementation(() => now() + slipMs);
    try {
      const warnings = mainWarnMock.mock.calls.length;
      jest.advanceTimersByTime(heartbeat.every);
      slipMs = 2_000;
      jest.advanceTimersByTime(heartbeat.wait);
      expect(mainWarnMock.mock.calls.slice(warnings)).toEqual([]);
      socket.emit("message", { data: RELAY_PONG });
      jest.advanceTimersByTime(heartbeat.every);
      expect(socket.closed).toBe(false);
      expect(mainWarnMock.mock.calls.slice(warnings).map(([message]) => message)).toEqual([
        expect.stringContaining("consecutive=1 reconnect=false"),
      ]);
    } finally {
      clock.mockRestore();
      relay.stop();
    }
  });

  test("relay errors reach the room with or without a message or sequence", async () => {
    const { relay, socket, frames } = await open();
    try {
      socket.emit("message", { data: '{"t":"error","code":"rate-limited","seq":42}' });
      socket.emit("message", { data: '{"t":"error","code":"rate-limited"}' });
      socket.emit("message", { data: '{"t":"error","code":"too-big","message":"too big"}' });
      expect(frames).toEqual([
        { t: "error", code: "rate-limited", message: "", seq: 42 },
        { t: "error", code: "rate-limited", message: "" },
        { t: "error", code: "too-big", message: "too big" },
      ]);
    } finally {
      relay.stop();
    }
  });

  test("flooding backs off despite presence and resets only after a sustained connection", async () => {
    const { relay, sockets, statuses } = await open({ every: 2_000_000, wait: 1_000 });
    try {
      const warnings = mainWarnMock.mock.calls.length;
      for (const [index, delay] of [60_000, 120_000, 240_000, 60_000].entries()) {
        const socket = sockets[index];
        if (index > 0) socket?.emit("open");
        relay.healthy();
        if (index === 3) jest.advanceTimersByTime(10 * 60_000);

        socket?.emit("close", { code: CLOSE_FLOODING });
        expect(statuses.at(-1)).toBe("waiting");
        jest.advanceTimersByTime(delay - 1);
        await Promise.resolve();
        expect(sockets).toHaveLength(index + 1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(sockets).toHaveLength(index + 2);
      }
      expect(mainWarnMock.mock.calls.slice(warnings).map(([msg]) => msg)).toEqual([
        expect.stringContaining("code=4002 retryMs=60000"),
        expect.stringContaining("code=4002 retryMs=120000"),
        expect.stringContaining("code=4002 retryMs=240000"),
        expect.stringContaining("code=4002 retryMs=60000"),
      ]);
    } finally {
      relay.stop();
    }
  });

  test("incoming presence does not satisfy a client ping", async () => {
    const { relay, socket, sockets, frames } = await open();
    try {
      jest.advanceTimersByTime(heartbeat.every);
      socket.emit("message", { data: '{"t":"presence","self":"a","devices":[]}' });
      expect(frames).toHaveLength(1);
      jest.advanceTimersByTime(heartbeat.wait);
      expect(socket.closed).toBe(false);
      jest.advanceTimersByTime(heartbeat.every);
      await Promise.resolve();
      expect(socket.closed).toBe(true);
      expect(socket.closes).toEqual([[1000, "pong-timeout"]]);
      expect(sockets).toHaveLength(2);
    } finally {
      relay.stop();
    }
  });

  test("a buffered write reconnects when it stops draining even if every ping gets a pong", async () => {
    const { relay, socket, sockets } = await open({ every: 1_000, wait: 2_000 });
    try {
      const frame = { t: "send", to: "a", seq: 1, kid: 1, nonce: "", box: "" } as const;
      socket.bufferedAmount = 100;
      expect(relay.send(frame)).toBe(true);
      const beat = () => {
        jest.advanceTimersByTime(1_000);
        socket.emit("message", { data: RELAY_PONG });
      };
      for (let i = 0; i < 5; i++) beat();
      socket.bufferedAmount = 50;
      beat();
      for (let i = 0; i < SEND_BUFFER_STALL_MS / 1000 - 1; i++) beat();
      expect(socket.closed).toBe(false);
      beat();
      await Promise.resolve();
      expect(socket.closed).toBe(true);
      expect(socket.closes).toEqual([[1000, "send-buffer-stalled"]]);
      expect(sockets).toHaveLength(2);
    } finally {
      relay.stop();
    }
  });

  test("none is sent once the socket is let go", async () => {
    const { relay, socket } = await open();
    relay.stop();
    jest.advanceTimersByTime(3 * heartbeat.every);
    expect(socket.sent).toEqual([]);
  });
});

test("a stuck socket handshake follows the normal unreachable route and backoff", async () => {
  jest.useFakeTimers();
  const unreachable = jest.fn();
  const socket = new FakeSocket("wss://nexus.example/relay?ticket=t");
  const relay = new RelayConnection({
    url: async () => socket.url,
    socket: () => socket,
    onOpen: () => {},
    onFrame: () => {},
    onStatus: () => {},
    onSignedOut: () => {},
    unreachable,
    backoff: () => 60_000,
  });
  try {
    relay.start();
    await Promise.resolve();
    jest.advanceTimersByTime(SOCKET_OPEN_TIMEOUT_MS);
    expect(socket.closed).toBe(true);
    expect(unreachable).toHaveBeenCalledTimes(1);
    socket.emit("close", { code: 1006 });
    expect(unreachable).toHaveBeenCalledTimes(1);
  } finally {
    relay.stop();
    jest.useRealTimers();
  }
});
