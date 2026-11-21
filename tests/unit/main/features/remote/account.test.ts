/**
 * Signing the app in to its NexusCode account: PKCE, the loopback the
 * browser comes back to, and the token traded for its code.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SavedAccount } from "../../../../../src/main/features/remote/account";
import {
  RemoteAccount,
  SignedOutError,
  thisDevice,
} from "../../../../../src/main/features/remote/account";
import { ServerError } from "../../../../../src/main/features/remote/errors";
import { listenForCallback } from "../../../../../src/main/features/remote/loopback";
import { challengeOf } from "../../../../../src/main/features/remote/pkce";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";

import { askTicket } from "../../../../../src/main/features/remote/ticket";
import { oversizedResponse } from "../../../../helpers/http-fixtures";

const SERVER = "http://localhost:8787";

const memoryStore = (initial: SavedAccount | null = null) => keptInMemory(initial);

const user = { id: "u1", email: "me@example.com", name: "Me" };
const device = { id: "d1", name: "Mac", platform: "darwin" };

/** A server that signs in whoever comes, and the requests it got. */
function fakeServer(
  options: {
    tokenStatus?: number;
    tokenError?: string;
    devicesStatus?: number;
    devicesError?: string;
  } = {},
) {
  const requests: {
    method: string;
    path: string;
    host: string;
    body?: unknown;
    auth?: string;
  }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      host: url.host,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    if (url.pathname === "/auth/token") {
      const status = options.tokenStatus ?? 200;
      const body =
        status === 200
          ? { token: "tok", expiresAt: Date.now() + 30 * 86_400_000, user, device }
          : { error: options.tokenError ?? "invalid_grant" };
      return new Response(JSON.stringify(body), { status });
    }
    if (url.pathname === "/devices") {
      const status = options.devicesStatus ?? 200;
      const body =
        status === 200
          ? { devices: [{ ...device, current: true }] }
          : { error: options.devicesError ?? "unauthorized" };
      return new Response(JSON.stringify(body), { status });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { requests, fetchFn };
}

/** A browser that goes through the sign-in and comes back, as told. */
function browser(back: (start: URL) => Record<string, string>) {
  const opened: URL[] = [];
  const openExternal = async (url: string) => {
    const start = new URL(url);
    opened.push(start);
    const redirect = new URL(start.searchParams.get("redirect_uri") ?? "");
    for (const [k, v] of Object.entries(back(start))) redirect.searchParams.set(k, v);
    await fetch(redirect);
  };
  return { opened, openExternal };
}

const accounts: RemoteAccount[] = [];
afterEach(() => {
  for (const a of accounts.splice(0)) a.cancelSignIn();
});

test.each([
  ["60", 60],
  ["Thu, 01 Jan 2026 00:01:00 GMT", 60],
  [undefined, undefined],
  ["1.5", undefined],
] as const)("preserves Retry-After %s from a ticket 429", async (header, retryAfter) => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const account = new RemoteAccount({
    server: SERVER,
    store: memoryStore({ server: SERVER, token: "mock", user, device }),
    openExternal: async () => {},
    fetch: (async () =>
      Response.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: header === undefined ? {} : { "Retry-After": header },
        },
      )) as unknown as typeof fetch,
  });
  try {
    await account.restore();
    await expect(askTicket(account)).rejects.toMatchObject({ status: 429, retryAfter });
  } finally {
    clock.mockRestore();
  }
});

describe("PKCE", () => {
  test("the S256 challenge of RFC 7636's example", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("the loopback", () => {
  test("takes one callback on 127.0.0.1 and nothing else", async () => {
    const listener = await listenForCallback(5_000);
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const other = await fetch(listener.redirectUri.replace("/callback", "/favicon.ico"));
    expect(other.status).toBe(404);
    await fetch(`${listener.redirectUri}?code=c1&state=s1`);
    expect(await listener.result).toEqual({ code: "c1", error: undefined, state: "s1" });
  });

  test("gives up when the time is up", async () => {
    const listener = await listenForCallback(20);
    await expect(listener.result).rejects.toMatchObject({ failure: "timed-out" });
  });
});

describe("the way to the server", () => {
  const PROXY = "https://proxy.example";
  const saved = { server: SERVER, token: "tok", user, device };
  /** The server, behind a proxy that fails as told. */
  function behind(proxy: (url: URL) => Error | null) {
    const server = fakeServer();
    const fetchFn = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const failure = url.origin === PROXY ? proxy(url) : null;
      if (failure) throw failure;
      return server.fetchFn(input, init);
    }) as typeof fetch;
    return { server, fetchFn };
  }

  test("signs in at the server's own page, asks through the proxy, and stays the server's", async () => {
    const { server, fetchFn } = behind(() => null);
    const { opened, openExternal } = browser((start) => ({
      code: "c1",
      state: start.searchParams.get("state") ?? "",
    }));
    const store = memoryStore();
    const account = new RemoteAccount({
      server: SERVER,
      proxy: PROXY,
      store,
      openExternal,
      fetch: fetchFn,
    });
    accounts.push(account);
    expect(await account.signIn()).toMatchObject({ status: "signed-in", server: SERVER });
    expect(opened[0]?.origin).toBe(SERVER);
    expect(server.requests.map((r) => [r.path, r.host])).toEqual([
      ["/auth/token", "proxy.example"],
    ]);
    expect(store.value?.server).toBe(SERVER);
  });

  test("a proxy not reached: the request goes again straight, and the next ones too", async () => {
    let now = 0;
    const { server, fetchFn } = behind(() => new TypeError("fetch failed"));
    const account = new RemoteAccount({
      server: SERVER,
      proxy: PROXY,
      store: memoryStore(saved),
      openExternal: async () => {},
      fetch: fetchFn,
      now: () => now,
    });
    await account.restore();
    expect(await account.devices()).toEqual([{ ...device, current: true }]);
    expect(await account.devices()).toHaveLength(1);
    expect(server.requests.map((r) => r.host)).toEqual(["localhost:8787", "localhost:8787"]);
    expect(account.route.base()).toBe(SERVER);
    // After a while, the proxy is tried again.
    now = 5 * 60_000;
    expect(account.route.base()).toBe(PROXY);
  });

  test("one through the proxy that timed out is not sent again; the next goes straight", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { server, fetchFn } = behind(() => timeout);
    const account = new RemoteAccount({
      server: SERVER,
      proxy: PROXY,
      store: memoryStore(saved),
      openExternal: async () => {},
      fetch: fetchFn,
      now: () => 0,
    });
    await account.restore();
    await expect(account.devices()).rejects.toThrow("did not answer");
    expect(server.requests).toEqual([]);
    expect(await account.devices()).toHaveLength(1);
    expect(server.requests.map((r) => r.host)).toEqual(["localhost:8787"]);
  });
});

describe("the account", () => {
  test.each([
    "unauthorized",
    "unreachable",
  ] as const)("ignores an old relay ticket's %s result after the next ticket succeeded", async (failure) => {
    const proxy = "https://proxy.example";
    const store = memoryStore({ server: SERVER, token: "tok", user, device });
    const earlier = Promise.withResolvers<Response>();
    let asked = 0;
    const account = new RemoteAccount({
      server: SERVER,
      proxy,
      store,
      openExternal: async () => {},
      fetch: (() =>
        asked++ === 0
          ? earlier.promise
          : Promise.resolve(new Response(JSON.stringify({ ticket: "new" })))) as typeof fetch,
    });
    await account.restore();
    const attempt = new AbortController();
    const old = askTicket(account, undefined, attempt.signal).catch((error: unknown) => error);
    attempt.abort();
    expect(await askTicket(account)).toBe("new");
    if (failure === "unauthorized") earlier.resolve(new Response(null, { status: 401 }));
    else earlier.reject(new TypeError("fetch failed"));

    expect(await old).toMatchObject({ name: "AbortError" });
    expect(account.state().status).toBe("signed-in");
    expect(store.value?.token).toBe("tok");
    expect(account.route.base()).toBe(proxy);
    expect(asked).toBe(2);
  });

  test("a current relay ticket's unauthorized response still signs out the account", async () => {
    const account = new RemoteAccount({
      server: SERVER,
      store: memoryStore({ server: SERVER, token: "tok", user, device }),
      openExternal: async () => {},
      fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    await account.restore();

    await expect(
      askTicket(account, undefined, new AbortController().signal),
    ).rejects.toBeInstanceOf(SignedOutError);
    expect(account.state().status).toBe("signed-out");
  });

  test.each([
    ["google", undefined],
    ["apple", "apple"],
  ] as const)("signs in with %s through the browser with PKCE and keeps the device's token", async (provider, choice) => {
    const store = memoryStore();
    const server = fakeServer();
    const { opened, openExternal } = browser((start) => ({
      code: "c1",
      state: start.searchParams.get("state") ?? "",
    }));
    const states: string[] = [];
    const account = new RemoteAccount({
      server: SERVER,
      store,
      openExternal,
      fetch: server.fetchFn,
      onChange: (s) => states.push(s.status),
      device: { name: "Mac", platform: "darwin" },
    });
    accounts.push(account);
    const state = await account.signIn(choice);
    expect(state).toEqual({ status: "signed-in", server: SERVER, user, device });
    expect(states).toEqual(["signing-in", "signed-in"]);
    const start = opened[0] as URL;
    expect(start.origin).toBe(SERVER);
    expect(start.pathname).toBe(`/auth/${provider}/start`);
    expect(start.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(start.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(start.searchParams.get("code_challenge_method")).toBe("S256");
    const trade = server.requests.find((r) => r.path === "/auth/token");
    const body = trade?.body as { code_verifier: string; redirect_uri: string; code: string };
    expect(trade?.method).toBe("POST");
    expect(challengeOf(body.code_verifier)).toBe(start.searchParams.get("code_challenge") ?? "");
    expect(body.redirect_uri).toBe(start.searchParams.get("redirect_uri") ?? "");
    expect(body.code).toBe("c1");
    expect(trade?.auth).toBeUndefined();
    expect(store.value?.token).toBe("tok");
    expect(account.token()).toBe("tok");
  });

  test("a sign-in that does not finish says why", async () => {
    const cases = [
      [{ code: "c1", state: "forged" }, {}, "mismatch"],
      [{ error: "access_denied" }, {}, "access_denied"],
      [{ error: "unverified_email" }, {}, "unverified_email"],
      [{ error: "not_invited" }, {}, "not_invited"],
      [{ error: "something_new" }, {}, "failed"],
      [{ code: "c1" }, { tokenStatus: 400 }, "invalid_grant"],
      [{ code: "c1" }, { tokenStatus: 409, tokenError: "too_many_devices" }, "too_many_devices"],
      [{ code: "c1" }, { tokenStatus: 409, tokenError: "conflict" }, "failed"],
    ] as const;
    for (const [back, serverOptions, failure] of cases) {
      const store = memoryStore();
      const account = new RemoteAccount({
        server: SERVER,
        store,
        openExternal: browser((start) => ({
          state: start.searchParams.get("state") ?? "",
          ...back,
        })).openExternal,
        fetch: fakeServer(serverOptions).fetchFn,
      });
      accounts.push(account);
      expect(await account.signIn()).toEqual({ status: "signed-out", server: SERVER, failure });
      expect(store.value).toBeNull();
    }
  });

  test("a cancelled sign-in, and one whose server is down", async () => {
    const opened: string[] = [];
    const cancelled = new RemoteAccount({
      server: SERVER,
      store: memoryStore(),
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    accounts.push(cancelled);
    const pending = cancelled.signIn();
    while (opened.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(cancelled.state().status).toBe("signing-in");
    cancelled.cancelSignIn();
    expect((await pending) as unknown).toMatchObject({
      status: "signed-out",
      failure: "cancelled",
    });

    const down = new RemoteAccount({
      server: SERVER,
      store: memoryStore(),
      openExternal: browser((start) => ({
        code: "c1",
        state: start.searchParams.get("state") ?? "",
      })).openExternal,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    accounts.push(down);
    expect((await down.signIn()) as unknown).toMatchObject({ failure: "unreachable" });
  });

  test("asks with its token, and a 401 signs it out", async () => {
    const saved = { server: SERVER, token: "tok", user, device };
    const ok = fakeServer();
    const account = new RemoteAccount({
      server: SERVER,
      store: memoryStore(saved),
      openExternal: async () => {},
      fetch: ok.fetchFn,
    });
    await account.restore();
    expect(account.state().status).toBe("signed-in");
    expect(await account.devices()).toEqual([{ ...device, current: true }]);
    expect(ok.requests[0]?.auth).toBe("Bearer tok");

    const store = memoryStore(saved);
    const gone = new RemoteAccount({
      server: SERVER,
      store,
      openExternal: async () => {},
      fetch: fakeServer({ devicesStatus: 401 }).fetchFn,
    });
    await gone.restore();
    await expect(gone.devices()).rejects.toBeInstanceOf(SignedOutError);
    expect(gone.state().status).toBe("signed-out");
    expect(store.value).toBeNull();
  });

  test("simultaneous socket revocations recheck /me once and a 401 clears the sign-in", async () => {
    const store = memoryStore({ server: SERVER, token: "tok", user, device });
    const response = Promise.withResolvers<Response>();
    const signedOut = Promise.withResolvers<void>();
    const paths: string[] = [];
    const account = new RemoteAccount({
      server: SERVER,
      store,
      openExternal: async () => {},
      fetch: ((url: URL) => {
        paths.push(url.pathname);
        return response.promise;
      }) as typeof fetch,
      onChange: (state) => {
        if (state.status === "signed-out") signedOut.resolve();
      },
    });
    await account.restore();
    account.recheckSignIn();
    account.recheckSignIn();
    expect(paths).toEqual(["/me"]);
    response.resolve(new Response(null, { status: 401 }));
    await signedOut.promise;
    expect(store.value).toBeNull();
    account.recheckSignIn();
    expect(paths).toEqual(["/me"]);
  });

  test("a 403 not_invited signs it out and says why; another 403 does not", async () => {
    const saved = { server: SERVER, token: "tok", user, device };
    const store = memoryStore(saved);
    const dropped = new RemoteAccount({
      server: SERVER,
      store,
      openExternal: async () => {},
      fetch: fakeServer({ devicesStatus: 403, devicesError: "not_invited" }).fetchFn,
    });
    accounts.push(dropped);
    await dropped.restore();
    await expect(dropped.devices()).rejects.toBeInstanceOf(SignedOutError);
    expect(dropped.state()).toEqual({
      status: "signed-out",
      server: SERVER,
      failure: "not_invited",
    });
    expect(store.value).toBeNull();

    const kept = memoryStore(saved);
    const forbidden = new RemoteAccount({
      server: SERVER,
      store: kept,
      openExternal: async () => {},
      fetch: fakeServer({ devicesStatus: 403, devicesError: "forbidden" }).fetchFn,
    });
    accounts.push(forbidden);
    await forbidden.restore();
    await expect(forbidden.devices()).rejects.toBeInstanceOf(ServerError);
    expect(forbidden.state().status).toBe("signed-in");
    expect(kept.value).not.toBeNull();
  });

  test.each([
    ["a 401", { status: 401, error: "unauthorized" }],
    ["a 403 not_invited", { status: 403, error: "not_invited" }],
  ] as const)("%s for a request sent before signing out and in again leaves the new sign-in", async (_, refusal) => {
    const store = memoryStore({ server: SERVER, token: "old", user, device });
    const server = fakeServer();
    const answer = Promise.withResolvers<Response>();
    const { openExternal } = browser((start) => ({
      code: "c1",
      state: start.searchParams.get("state") ?? "",
    }));
    const account = new RemoteAccount({
      server: SERVER,
      store,
      openExternal,
      fetch: ((input: URL | string, init?: RequestInit) => {
        // A long upload, sent with the token of the sign-in about to end.
        if (new URL(String(input)).pathname === "/voice/transcriptions") return answer.promise;
        return server.fetchFn(input, init);
      }) as typeof fetch,
    });
    accounts.push(account);
    await account.restore();
    const upload = account
      .upload("/voice/transcriptions", new Uint8Array([1]), { type: "audio/ogg" })
      .catch((error: unknown) => error);
    await account.signOut();
    expect((await account.signIn()).status).toBe("signed-in");
    expect(store.value?.token).toBe("tok");

    // The old token's refusal comes back only now.
    answer.resolve(new Response(JSON.stringify({ error: refusal.error }), refusal));
    expect(await upload).toBeInstanceOf(SignedOutError);
    expect(account.state()).toEqual({ status: "signed-in", server: SERVER, user, device });
    expect(store.value?.token).toBe("tok");
  });

  test("removing this device, signing out, or deleting the account forgets the sign-in", async () => {
    const saved = { server: SERVER, token: "tok", user, device };
    for (const leave of [
      (a: RemoteAccount) => a.removeDevice("d1"),
      (a: RemoteAccount) => a.signOut(),
      (a: RemoteAccount) => a.deleteAccount(),
    ]) {
      const store = memoryStore(saved);
      const server = fakeServer();
      const account = new RemoteAccount({
        server: SERVER,
        store,
        openExternal: async () => {},
        fetch: server.fetchFn,
      });
      await account.restore();
      await leave(account);
      expect(account.state().status).toBe("signed-out");
      expect(store.value).toBeNull();
      expect(server.requests[0]?.auth).toBe("Bearer tok");
    }
  });

  test("signs in with this install's id, so the server gives the same device back", async () => {
    const trades: unknown[] = [];
    for (const installId of [async () => "abcdefghijklmnop1234", undefined]) {
      const server = fakeServer();
      const { openExternal } = browser((start) => ({
        code: "c1",
        state: start.searchParams.get("state") ?? "",
      }));
      const account = new RemoteAccount({
        server: SERVER,
        store: memoryStore(),
        openExternal,
        fetch: server.fetchFn,
        device: { name: "Mac", platform: "darwin" },
        ...(installId ? { installId } : {}),
      });
      accounts.push(account);
      expect((await account.signIn()).status).toBe("signed-in");
      trades.push(
        (server.requests.find((r) => r.path === "/auth/token")?.body as { device: unknown }).device,
      );
    }
    expect(trades).toEqual([
      { name: "Mac", platform: "darwin", installId: "abcdefghijklmnop1234" },
      { name: "Mac", platform: "darwin" },
    ]);
  });

  test("gives a device an alias or takes it away, and keeps this one's", async () => {
    const store = memoryStore({ server: SERVER, token: "tok", user, device });
    const server = fakeServer();
    const account = new RemoteAccount({
      server: SERVER,
      store,
      openExternal: async () => {},
      fetch: server.fetchFn,
    });
    await account.restore();
    await account.setDeviceAlias("d1", "  Studio ");
    await account.setDeviceAlias("d2", "");
    expect(server.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["PATCH", "/devices/d1", { alias: "Studio" }],
      ["PATCH", "/devices/d2", { alias: null }],
    ]);
    expect(store.value?.device).toEqual({ ...device, alias: "Studio" });
    const state = account.state();
    expect(state.status === "signed-in" && state.device.alias).toBe("Studio");
    await account.setDeviceAlias("d1", null);
    expect(store.value?.device.alias).toBeNull();
  });

  test.each([
    {
      case: "same name sends nothing",
      now: "Mac",
      signedIn: true,
      status: 204,
      sent: 0,
      kept: "Mac",
    },
    {
      case: "new name is sent and kept",
      now: "Studio",
      signedIn: true,
      status: 204,
      sent: 1,
      kept: "Studio",
    },
    {
      case: "a failed request keeps the old name",
      now: "Studio",
      signedIn: true,
      status: 500,
      sent: 1,
      kept: "Mac",
    },
    {
      case: "signed out sends nothing",
      now: "Studio",
      signedIn: false,
      status: 204,
      sent: 0,
      kept: undefined,
    },
  ])("syncs a renamed device: $case", async ({ now, signedIn, status, sent, kept }) => {
    const store = memoryStore(signedIn ? { server: SERVER, token: "tok", user, device } : null);
    const requests: { method: string; path: string; body: unknown }[] = [];
    const account = new RemoteAccount({
      server: SERVER,
      store,
      openExternal: async () => {},
      device: { name: now, platform: "darwin" },
      fetch: (async (input: URL | string, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return new Response(null, { status });
      }) as typeof fetch,
    });
    await account.restore();
    await account.syncDeviceName();
    expect(requests).toHaveLength(sent);
    if (sent)
      expect(requests[0]).toEqual({ method: "PATCH", path: "/devices/d1", body: { name: now } });
    expect(store.value?.device.name).toBe(kept);
  });

  test("names the device as the server takes it", () => {
    const { name, platform } = thisDevice();
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(platform).toMatch(/^[a-z0-9-]{1,32}$/);
  });

  test("signs in with the dev server's sign-in, as the email given", async () => {
    const { opened, openExternal } = browser((start) => ({
      code: "c1",
      state: start.searchParams.get("state") ?? "",
    }));
    const account = new RemoteAccount({
      server: SERVER,
      store: memoryStore(),
      openExternal,
      fetch: fakeServer().fetchFn,
      provider: "dev",
      loginHint: "a@example.com",
    });
    accounts.push(account);
    expect((await account.signIn()).status).toBe("signed-in");
    expect(opened[0]?.pathname).toBe("/auth/dev/start");
    expect(opened[0]?.searchParams.get("login_hint")).toBe("a@example.com");
  });

  test("a sign-in to another server is not this one's", async () => {
    const account = new RemoteAccount({
      server: SERVER,
      store: memoryStore({ server: "https://elsewhere", token: "t", user, device }),
      openExternal: async () => {},
    });
    await account.restore();
    expect(account.state().status).toBe("signed-out");
  });
});

test("an oversized account response fails with a response size code", async () => {
  const response = oversizedResponse(8);
  const account = new RemoteAccount({
    server: SERVER,
    store: memoryStore({ server: SERVER, token: "test", user, device }),
    openExternal: async () => {},
    fetch: response.fetch,
  });
  await account.restore();
  await expect(account.devices()).rejects.toMatchObject({ code: "response-too-large" });
  expect(response.cancelled()).toBe(true);
});
