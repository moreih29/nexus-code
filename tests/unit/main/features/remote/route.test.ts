/** How requests reach the server: through the proxy, straight for a while when it fails. */
import { describe, expect, test } from "bun:test";
import { PROXY_DOWN_MS, ServerRoute } from "../../../../../src/main/features/remote/route";

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
