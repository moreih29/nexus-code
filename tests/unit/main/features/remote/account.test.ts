/**
 * Signing the app in to its NexusCode account: PKCE, the loopback the
 * browser comes back to, and the token traded for its code.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
  const requests: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
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

describe("the account", () => {
  test("signs in through the browser with PKCE and keeps the device's token", async () => {
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
    const state = await account.signIn();
    expect(state).toEqual({ status: "signed-in", server: SERVER, user, device });
    expect(states).toEqual(["signing-in", "signed-in"]);
    const start = opened[0] as URL;
    expect(start.pathname).toBe("/auth/google/start");
    expect(start.searchParams.get("code_challenge_method")).toBe("S256");
    const trade = server.requests.find((r) => r.path === "/auth/token");
    const body = trade?.body as { code_verifier: string; redirect_uri: string; code: string };
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
