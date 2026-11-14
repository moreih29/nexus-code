/** The account password's flows, against a server that keeps one locked bundle. */
import { describe, expect, test } from "bun:test";
import type { KeyBundle } from "../../../../../packages/remote-protocol/src";
import { AccountKeys, type SavedKey } from "../../../../../src/main/features/remote/account-keys";
import {
  ServerError,
  SignedOutError,
  UnreachableError,
} from "../../../../../src/main/features/remote/errors";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import type { AccountKeyState, RemoteAccountState } from "../../../../../src/shared/remote/account";

const kdf = { ops: 1, mem: 16 * 1024 * 1024 };
const PASSWORD = "correct horse battery";
const OTHER = "staple paper clip tray";

function signedIn(userId = "u1"): RemoteAccountState {
  return {
    status: "signed-in",
    server: "http://localhost:8787",
    user: { id: userId, email: "me@example.com", name: "Me" },
    device: { id: "d1", name: "Mac", platform: "darwin" },
  };
}

/** The server's one bundle per account, as the contract has it. */
function bundleServer() {
  const server = {
    stored: null as { bundle: KeyBundle; version: number } | null,
    fail: null as Error | null,
    puts: 0,
  };
  const request = async (method: string, _path: string, body?: unknown) => {
    if (server.fail) throw server.fail;
    if (method === "GET") {
      if (!server.stored) throw new ServerError(404, "not_found", "GET");
      return structuredClone(server.stored);
    }
    const { bundle, expected } = body as { bundle: KeyBundle; expected: number | null };
    if (expected !== (server.stored?.version ?? null))
      throw new ServerError(409, "conflict", "PUT");
    if (server.stored && bundle.kid < server.stored.bundle.kid) {
      throw new ServerError(400, "kid_downgrade", "PUT");
    }
    server.puts += 1;
    server.stored = { bundle, version: (server.stored?.version ?? 0) + 1 };
    return { version: server.stored.version };
  };
  return { server, request };
}

/** A device of the account: its own kept key, the shared server. */
function device(request: ReturnType<typeof bundleServer>["request"], account = signedIn()) {
  const store = keptInMemory<SavedKey>();
  const states: AccountKeyState["status"][] = [];
  let state = account;
  const keys = new AccountKeys({
    account: { state: () => state, request },
    store,
    kdf,
    onChange: (s) => states.push(s.status),
    now: () => 1_000,
  });
  return {
    keys,
    store,
    states,
    signOut: () => {
      state = { status: "signed-out", server: state.server };
      return keys.accountChanged(state);
    },
  };
}

describe("the account key's flows", () => {
  test("the first device sets the password; another takes the key with it", async () => {
    const { server, request } = bundleServer();
    const first = device(request);
    await first.keys.restore();
    expect(first.keys.state()).toEqual({ status: "missing" });
    expect(await first.keys.create(PASSWORD)).toEqual({ status: "unlocked", kid: 1 });
    expect(server.stored?.version).toBe(1);
    expect(first.store.value?.kid).toBe(1);

    const second = device(request);
    await second.keys.restore();
    expect(second.keys.state()).toEqual({ status: "locked", kid: 1 });
    await expect(second.keys.unlock(OTHER)).rejects.toMatchObject({ failure: "wrong-password" });
    expect(await second.keys.unlock(PASSWORD)).toEqual({ status: "unlocked", kid: 1 });
    expect(second.keys.key()?.key).toEqual(first.keys.key()?.key as Uint8Array);
  });

  test("refuses a password under 12 characters before it asks the server", async () => {
    const { server, request } = bundleServer();
    const first = device(request);
    await first.keys.restore();
    await expect(first.keys.create("short")).rejects.toMatchObject({ failure: "too-short" });
    expect(server.puts).toBe(0);
  });

  test("two first devices: the second finds the first's bundle and is told to type it", async () => {
    const { request } = bundleServer();
    const a = device(request);
    const b = device(request);
    await a.keys.restore();
    await b.keys.restore();
    await a.keys.create(PASSWORD);
    await expect(b.keys.create(OTHER)).rejects.toMatchObject({ failure: "conflict" });
    expect(b.keys.state()).toEqual({ status: "locked", kid: 1 });
  });

  test("a new password keeps the key; the old password no longer opens it", async () => {
    const { request } = bundleServer();
    const first = device(request);
    await first.keys.restore();
    await first.keys.create(PASSWORD);
    const key = first.keys.key()?.key;
    await expect(first.keys.changePassword(OTHER, OTHER)).rejects.toMatchObject({
      failure: "wrong-password",
    });
    expect(await first.keys.changePassword(PASSWORD, OTHER)).toEqual({
      status: "unlocked",
      kid: 1,
    });

    const second = device(request);
    await second.keys.restore();
    await expect(second.keys.unlock(PASSWORD)).rejects.toMatchObject({ failure: "wrong-password" });
    await second.keys.unlock(OTHER);
    expect(second.keys.key()?.key).toEqual(key as Uint8Array);
  });

  test("a reset makes the next key; other devices find it locked until they type the new password", async () => {
    const { request } = bundleServer();
    const a = device(request);
    const b = device(request);
    await a.keys.restore();
    await a.keys.create(PASSWORD);
    await b.keys.restore();
    await b.keys.unlock(PASSWORD);
    const old = b.keys.key()?.key;

    expect(await a.keys.reset(OTHER)).toEqual({ status: "unlocked", kid: 2 });
    expect(a.keys.key()?.key).not.toEqual(old as Uint8Array);
    expect(await b.keys.refresh()).toEqual({ status: "locked", kid: 2 });
    expect(b.keys.key()).toBeNull();
    await b.keys.unlock(OTHER);
    expect(b.keys.key()).toEqual(a.keys.key());
  });

  test("a server that goes back to an older key is not followed: the newer key stays", async () => {
    const { server, request } = bundleServer();
    const a = device(request);
    await a.keys.restore();
    await a.keys.create(PASSWORD);
    const first = structuredClone(server.stored);
    expect(await a.keys.reset(OTHER)).toEqual({ status: "unlocked", kid: 2 });
    const newer = a.keys.key();
    // The server (or one that holds its data) hands out the first bundle again.
    server.stored = first;
    expect(await a.keys.refresh()).toEqual({ status: "unlocked", kid: 2 });
    expect(a.keys.key()).toEqual(newer);
    // Nor does the old password take the old key back, nor a change of it.
    await expect(a.keys.unlock(PASSWORD)).rejects.toMatchObject({ failure: "conflict" });
    await expect(a.keys.changePassword(PASSWORD, "a new long password")).rejects.toMatchObject({
      failure: "conflict",
    });
    expect(a.keys.key()).toEqual(newer);
  });

  test("signing out forgets the key; another user's kept key is not taken", async () => {
    const { request } = bundleServer();
    const a = device(request);
    await a.keys.restore();
    await a.keys.create(PASSWORD);
    await a.signOut();
    expect(a.keys.state()).toEqual({ status: "signed-out" });
    expect(a.store.value).toBeNull();

    const store = keptInMemory<SavedKey>({ userId: "u2", kid: 1, key: "AAAA" });
    const keys = new AccountKeys({ account: { state: () => signedIn("u1"), request }, store, kdf });
    await keys.restore();
    expect(keys.state()).toEqual({ status: "locked", kid: 1 });
    expect(store.value).toBeNull();
  });

  test("a key held is used at once, and while the server cannot say whether it is current", async () => {
    const { server, request } = bundleServer();
    const a = device(request);
    await a.keys.restore();
    await a.keys.create(PASSWORD);
    const store = keptInMemory<SavedKey>(a.store.value);
    server.fail = new ServerError(429, "rate_limited", "GET", 60);
    const keys = new AccountKeys({ account: { state: () => signedIn(), request }, store, kdf });
    await keys.restore();
    expect(keys.state()).toEqual({ status: "unlocked", kid: 1 });
    expect(keys.key()?.key).toEqual(a.keys.key()?.key as Uint8Array);
  });

  test("a server that asks to wait, cannot be reached, or signed the device out", async () => {
    const { server, request } = bundleServer();
    const a = device(request);
    server.fail = new ServerError(429, "rate_limited", "GET", 60);
    expect(await a.keys.refresh()).toEqual({ status: "unavailable", retryAt: 61_000 });
    server.fail = new UnreachableError(new TypeError("fetch failed"));
    expect(await a.keys.refresh()).toEqual({ status: "unavailable" });
    await expect(a.keys.unlock(PASSWORD)).rejects.toMatchObject({ failure: "unavailable" });
    server.fail = new SignedOutError();
    await expect(a.keys.unlock(PASSWORD)).rejects.toMatchObject({ failure: "signed-out" });
  });
});
