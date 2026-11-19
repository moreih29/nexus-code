/** How requests reach the server: through the proxy, straight for a while when it fails. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  PROXY_DOWN_MS,
  returnToProxy,
  ServerRoute,
} from "../../../../../src/main/features/remote/route";

const SERVER = "https://nexus.example";
const PROXY = "https://proxy.example";

describe("the route to the server", () => {
  test("goes through the proxy, and straight for a while once it could not be reached", () => {
    let now = 1000;
    const route = new ServerRoute(SERVER, PROXY, () => now);
    expect(route.base()).toBe(PROXY);
    expect(route.unreachable(`${PROXY}/relay/ticket`)).toBe(true);
    expect(route.base()).toBe(SERVER);
    now += PROXY_DOWN_MS - 1;
    expect(route.base()).toBe(SERVER);
    now += 1;
    expect(route.base()).toBe(PROXY);
  });

  test("a websocket's address to the proxy counts as the proxy's; the server's does not", () => {
    const route = new ServerRoute(SERVER, PROXY, () => 0);
    expect(route.unreachable(`${SERVER}/devices`)).toBe(false);
    expect(route.base()).toBe(PROXY);
    expect(route.unreachable("wss://proxy.example/relay?v=1&ticket=t")).toBe(true);
    expect(route.base()).toBe(SERVER);
  });

  test("without a proxy, always straight", () => {
    const route = new ServerRoute(SERVER);
    expect(route.base()).toBe(SERVER);
    expect(route.unreachable(`${SERVER}/x`)).toBe(false);
    expect(route.base()).toBe(SERVER);
  });

  test("makes the addresses: a path where requests go now, a websocket's as ws(s)", () => {
    const route = new ServerRoute("http://localhost:8787", PROXY, () => 0);
    expect(route.url("/devices").toString()).toBe(`${PROXY}/devices`);
    expect(route.url("/relay", { socket: true }).toString()).toBe("wss://proxy.example/relay");
    expect(route.url("/voice", { socket: true, base: "http://localhost:8787" }).toString()).toBe(
      "ws://localhost:8787/voice",
    );
  });
});

describe("a socket that went straight", () => {
  const probes: ReturnType<typeof returnToProxy>[] = [];
  afterEach(() => {
    for (const probe of probes.splice(0)) probe.stop();
  });

  /** Controls the socket and the route independently of the probe response. */
  function setup(answer: () => Response | Error) {
    let now = 0;
    const route = new ServerRoute(SERVER, PROXY, () => now);
    let via: { origin: string } | null = { origin: "wss://nexus.example" };
    const asked: string[] = [];
    let reconnects = 0;
    const back = returnToProxy({
      route,
      via: () => via,
      reconnect: () => {
        reconnects += 1;
      },
      fetch: (async (input: URL | string) => {
        asked.push(String(input));
        const result = answer();
        if (result instanceof Error) throw result;
        return result;
      }) as typeof fetch,
    });
    probes.push(back);
    return {
      route,
      back,
      asked,
      reconnects: () => reconnects,
      at: (ms: number) => {
        now = ms;
      },
      goes: (to: string | null) => {
        via = to ? { origin: to } : null;
      },
    };
  }

  test("goes back through the proxy once requests do and the proxy answers", async () => {
    const t = setup(() => new Response("{}"));
    t.route.unreachable(PROXY);
    // Still passing the proxy by: nothing asked.
    await t.back.check();
    expect(t.asked).toEqual([]);
    t.at(PROXY_DOWN_MS);
    await t.back.check();
    expect(t.asked).toEqual([`${PROXY}/info`]);
    expect(t.reconnects()).toBe(1);
  });

  test("one through the proxy, or none open, is left be", async () => {
    const t = setup(() => new Response("{}"));
    t.goes("wss://proxy.example");
    await t.back.check();
    t.goes(null);
    await t.back.check();
    expect([t.asked, t.reconnects()]).toEqual([[], 0]);
  });

  test.each([
    "disconnected",
    "replaced at the same origin",
    "on another route",
    "disposed",
  ] as const)("ignores a late probe success after the original connection is %s", async (change) => {
    const route = new ServerRoute(SERVER, PROXY, () => 0);
    const response = Promise.withResolvers<Response>();
    let via: { origin: string } | null = { origin: "wss://nexus.example" };
    let reconnects = 0;
    let probeSignal: AbortSignal | null | undefined;
    const probe = returnToProxy({
      route,
      via: () => via,
      reconnect: () => {
        reconnects += 1;
      },
      fetch: ((_input, init) => {
        probeSignal = init?.signal;
        return response.promise;
      }) as typeof fetch,
    });
    try {
      const pending = probe.check();
      if (change === "disconnected") via = null;
      else if (change === "replaced at the same origin") via = { origin: "wss://nexus.example" };
      else if (change === "on another route") route.unreachable(PROXY);
      else {
        probe.stop();
        expect(probeSignal?.aborted).toBe(true);
      }
      response.resolve(new Response("{}"));
      await pending;
      expect(reconnects).toBe(0);
    } finally {
      probe.stop();
    }
  });

  test("a late probe failure cannot put the proxy in cooldown for a new socket", async () => {
    const route = new ServerRoute(SERVER, PROXY, () => 0);
    const response = Promise.withResolvers<Response>();
    let connection = { origin: "wss://nexus.example" };
    const probe = returnToProxy({
      route,
      via: () => connection,
      reconnect: () => {},
      fetch: (() => response.promise) as typeof fetch,
    });
    probes.push(probe);
    const pending = probe.check();
    connection = { origin: "wss://nexus.example" };
    response.reject(new TypeError("old probe failed"));
    await pending;

    expect(route.base()).toBe(PROXY);
  });

  test("a proxy that does not answer, or answers with an error, is passed by again", async () => {
    for (const answer of [
      () => new TypeError("fetch failed"),
      () => new Response("", { status: 502 }),
    ]) {
      const t = setup(answer);
      await t.back.check();
      expect(t.asked).toHaveLength(1);
      expect(t.reconnects()).toBe(0);
      expect(t.route.base()).toBe(SERVER);
    }
  });
});
