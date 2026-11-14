/**
 * The account key's flows against a server of account keys v2: the
 * password's proof, device keys, rotation when a device is removed, and a
 * reset that waits (packages/remote-protocol's ACCOUNT_KEYS.md).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACCOUNT_AUTH_HEADER,
  type DeviceKey,
  type KeyBundle,
  type KeyEnvelope,
  KeyRotationSchema,
  RESET_DELAY_MS,
} from "../../../../../packages/remote-protocol/src";
import { fromBase64Url } from "../../../../../src/main/features/remote/account-key";
import { AccountKeys, type SavedKey } from "../../../../../src/main/features/remote/account-keys";
import { certChecks } from "../../../../../src/main/features/remote/device-key";
import { ServerError } from "../../../../../src/main/features/remote/errors";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import type { AccountKeyState, RemoteAccountState } from "../../../../../src/shared/remote/account";

const kdf = { ops: 1, mem: 16 * 1024 * 1024 };
const PASSWORD = "correct horse battery";
const OTHER = "staple paper clip tray";
const USER = "u1";

const sha = (b64: string) => createHash("sha256").update(fromBase64Url(b64)).digest("base64url");

/** A v2 server: one bundle, its verifier, the devices' keys and envelopes. */
function v2Server() {
  const s = {
    bundle: null as { bundle: KeyBundle; version: number } | null,
    verifier: null as string | null,
    pending: null as {
      bundle: KeyBundle;
      verifier: string;
      deviceId: string;
      appliesAt: number;
    } | null,
    devices: new Map<string, { key: DeviceKey | null }>(),
    envelopes: new Map<string, KeyEnvelope[]>(),
    rotations: [] as unknown[],
    deletes: [] as string[],
    now: 1_000,
  };
  const forbidden = () => new ServerError(403, "account-auth", "request");
  const proofOk = (headers?: Record<string, string>) =>
    s.verifier === null ||
    (headers?.[ACCOUNT_AUTH_HEADER] !== undefined &&
      sha(headers[ACCOUNT_AUTH_HEADER]) === s.verifier);

  function requestAs(deviceId: string) {
    s.devices.set(deviceId, s.devices.get(deviceId) ?? { key: null });
    return async (
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      if (!s.devices.has(deviceId)) throw new ServerError(401, "unauthorized", "request");
      const route = `${method} ${path}`;
      if (route === "GET /account/key-bundle") {
        if (!s.bundle) throw new ServerError(404, "not_found", route);
        return {
          ...structuredClone(s.bundle),
          hasVerifier: s.verifier !== null,
          pendingReset: s.pending
            ? { appliesAt: s.pending.appliesAt, deviceId: s.pending.deviceId }
            : null,
        };
      }
      if (route === "PUT /account/key-bundle") {
        const { bundle, expected, verifier } = body as {
          bundle: KeyBundle;
          expected: number | null;
          verifier?: string;
        };
        if (!proofOk(headers)) throw forbidden();
        if (expected !== (s.bundle?.version ?? null)) throw new ServerError(409, "conflict", route);
        s.bundle = { bundle, version: (s.bundle?.version ?? 0) + 1 };
        if (verifier) s.verifier = verifier;
        s.pending = null;
        return { version: s.bundle.version };
      }
      if (route === "PUT /account/key-verifier") {
        if (s.verifier !== null) throw new ServerError(409, "conflict", route);
        s.verifier = (body as { verifier: string }).verifier;
        return {};
      }
      if (route === "POST /account/key-reset") {
        if (s.pending) throw new ServerError(409, "conflict", route);
        const { bundle, verifier } = body as { bundle: KeyBundle; verifier: string };
        s.pending = { bundle, verifier, deviceId, appliesAt: s.now + RESET_DELAY_MS };
        return { appliesAt: s.pending.appliesAt, deviceId };
      }
      if (route === "DELETE /account/key-reset") {
        if (!proofOk(headers)) throw forbidden();
        s.pending = null;
        return {};
      }
      if (route === "PUT /devices/current/key") {
        const key = body as DeviceKey;
        const entry = s.devices.get(deviceId);
        if (entry) entry.key = key;
        const left = (s.envelopes.get(deviceId) ?? []).filter((e) => e.kid > key.kid);
        s.envelopes.set(deviceId, left);
        return {};
      }
      if (route === "GET /devices") {
        return {
          devices: [...s.devices].map(([id, d]) => ({
            id,
            name: id,
            platform: "darwin",
            key: d.key,
          })),
        };
      }
      if (route === "GET /devices/current/key-envelopes") {
        return { envelopes: s.envelopes.get(deviceId) ?? [] };
      }
      if (route === "POST /account/key-rotation") {
        const r = KeyRotationSchema.parse(body);
        if (!proofOk(headers)) throw forbidden();
        if (!s.bundle || r.expected !== s.bundle.version)
          throw new ServerError(409, "conflict", route);
        const k = s.bundle.bundle.kid;
        if (r.bundle.kid !== k + 1) throw new ServerError(400, "bad", route);
        const self = s.devices.get(deviceId);
        if (self?.key?.kid !== k || r.removeDeviceIds.includes(deviceId))
          throw new ServerError(400, "bad", route);
        for (const e of r.envelopes) {
          if (e.envelope.from !== deviceId || e.envelope.kid !== k + 1)
            throw new ServerError(400, "bad", route);
          if (e.envelope.fromKey.publicKey !== self.key.publicKey)
            throw new ServerError(400, "bad", route);
        }
        for (const [id, d] of s.devices) {
          if (id === deviceId || r.removeDeviceIds.includes(id)) continue;
          if (d.key?.kid === k && !r.envelopes.some((e) => e.deviceId === id)) {
            throw new ServerError(400, "uncovered", route);
          }
        }
        for (const id of r.removeDeviceIds) {
          s.devices.delete(id);
          s.envelopes.delete(id);
        }
        s.bundle = { bundle: r.bundle, version: s.bundle.version + 1 };
        s.verifier = r.verifier;
        s.pending = null;
        for (const e of r.envelopes) {
          s.envelopes.set(e.deviceId, [...(s.envelopes.get(e.deviceId) ?? []), e.envelope]);
        }
        for (const c of r.certs) {
          const d = s.devices.get(c.deviceId);
          if (d?.key && d.key.publicKey === c.publicKey)
            d.key = { publicKey: c.publicKey, kid: c.kid, cert: c.cert };
        }
        s.rotations.push(r);
        return { version: s.bundle.version };
      }
      if (method === "DELETE" && path.startsWith("/devices/")) {
        const id = decodeURIComponent(path.slice("/devices/".length));
        if (!(s.pending?.deviceId === id) && !proofOk(headers)) throw forbidden();
        if (s.pending?.deviceId === id) s.pending = null;
        s.devices.delete(id);
        s.deletes.push(id);
        return {};
      }
      throw new Error(`no such route: ${route}`);
    };
  }
  return { s, requestAs };
}

function device(server: ReturnType<typeof v2Server>, deviceId: string) {
  const store = keptInMemory<SavedKey>();
  const account: RemoteAccountState = {
    status: "signed-in",
    server: "http://localhost:8787",
    user: { id: USER, email: "me@example.com", name: "Me" },
    device: { id: deviceId, name: deviceId, platform: "darwin" },
  };
  const states: AccountKeyState[] = [];
  const keys = new AccountKeys({
    account: { state: () => account, request: server.requestAs(deviceId) },
    store,
    kdf,
    onChange: (state) => states.push(state),
    now: () => server.s.now,
  });
  return { keys, store, states };
}

/** Three devices holding the first key, each with its key registered. */
async function threeDevices() {
  const server = v2Server();
  const a = device(server, "dev-a");
  const b = device(server, "dev-b");
  const c = device(server, "dev-c");
  await a.keys.restore();
  await a.keys.create(PASSWORD);
  await b.keys.restore();
  await b.keys.unlock(PASSWORD);
  await c.keys.restore();
  await c.keys.unlock(PASSWORD);
  return { server, a, b, c };
}

describe("account keys v2", () => {
  test("the first device puts the verifier with the bundle, and each device registers its key", async () => {
    const { server, a, b } = await threeDevices();
    const { s } = server;
    expect(s.verifier).toHaveLength(43);
    expect(a.keys.state()).toEqual({ status: "unlocked", kid: 1, v2: true });
    const ak = a.keys.key()?.key as Uint8Array;
    for (const id of ["dev-a", "dev-b", "dev-c"]) {
      const key = s.devices.get(id)?.key as DeviceKey;
      expect(key.kid).toBe(1);
      expect(certChecks(ak, USER, id, key)).toBe(true);
    }
    expect((await b.store.load())?.registered).toBe(1);
  });

  test("an account without a verifier asks for the password once, and takes its proof after", async () => {
    const server = v2Server();
    const a = device(server, "dev-a");
    await a.keys.restore();
    await a.keys.create(PASSWORD);
    // As an account made before v2.
    server.s.verifier = null;
    await a.keys.refresh();
    expect(a.keys.state()).toEqual({ status: "unlocked", kid: 1, v2: true, needsProof: true });
    await expect(a.keys.confirmPassword(OTHER)).rejects.toMatchObject({
      failure: "wrong-password",
    });
    await a.keys.confirmPassword(PASSWORD);
    expect(server.s.verifier).not.toBeNull();
    expect(a.keys.state()).toEqual({ status: "unlocked", kid: 1, v2: true });
    // A new device's password fills one too.
    server.s.verifier = null;
    const b = device(server, "dev-b");
    await b.keys.restore();
    await b.keys.unlock(PASSWORD);
    expect(server.s.verifier).not.toBeNull();
  });

  test("a new password carries the old one's proof; a verifier of another's is account-auth", async () => {
    const { server, a } = await threeDevices();
    const before = server.s.verifier;
    await a.keys.changePassword(PASSWORD, OTHER);
    expect(server.s.verifier).not.toBe(before);
    // A stolen device put its own verifier: the owner's proof no longer goes through.
    server.s.verifier = sha("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await expect(a.keys.changePassword(OTHER, PASSWORD)).rejects.toMatchObject({
      failure: "account-auth",
    });
  });

  test("removing a device rotates the key: those that stay take it from an envelope, not the removed one", async () => {
    const { server, a, b, c } = await threeDevices();
    await expect(a.keys.removeDevices(["dev-c"])).rejects.toMatchObject({
      failure: "wrong-password",
    });
    await expect(a.keys.removeDevices(["dev-c"], OTHER)).rejects.toMatchObject({
      failure: "wrong-password",
    });
    await a.keys.removeDevices(["dev-c"], PASSWORD);
    const { s } = server;
    expect(s.bundle?.bundle.kid).toBe(2);
    expect(s.devices.has("dev-c")).toBe(false);
    expect(s.envelopes.get("dev-b")).toHaveLength(1);
    expect(a.keys.state()).toMatchObject({ status: "unlocked", kid: 2 });
    // B takes the new key without the password, the same as A's.
    await b.keys.refresh();
    expect(b.keys.state()).toMatchObject({ status: "unlocked", kid: 2 });
    expect(b.keys.key()?.key).toEqual(a.keys.key()?.key);
    // The rotation vouched for B's key anew; it opened its envelope, which the server drops on the next register.
    expect(s.devices.get("dev-b")?.key?.kid).toBe(2);
    // C is signed out; its old key opens nothing new.
    await expect(c.keys.refresh()).resolves.toBeDefined();
    expect(c.keys.key()?.kid).toBe(1);
  });

  test("a device without a key of the version before is asked for the password", async () => {
    const { server, a } = await threeDevices();
    // An older app's device: signed in and holding the key, but no key registered.
    server.s.devices.set("dev-old", { key: null });
    await a.keys.removeDevices(["dev-c"], PASSWORD);
    expect(server.s.envelopes.has("dev-old")).toBe(false);
  });

  test("a device that missed two rotations takes both, in order", async () => {
    const { server, a, b } = await threeDevices();
    const d = device(server, "dev-d");
    await d.keys.restore();
    await d.keys.unlock(PASSWORD);
    await a.keys.removeDevices(["dev-c"], PASSWORD);
    await a.keys.removeDevices(["dev-d"], PASSWORD);
    expect(server.s.envelopes.get("dev-b")?.map((e) => e.kid)).toEqual([2, 3]);
    await b.keys.refresh();
    expect(b.keys.state()).toMatchObject({ status: "unlocked", kid: 3 });
    expect(b.keys.key()?.key).toEqual(a.keys.key()?.key);
  });

  test("a device key that does not check stops the rotation", async () => {
    const { server, a } = await threeDevices();
    const b = server.s.devices.get("dev-b") as { key: DeviceKey };
    b.key = { ...b.key, publicKey: server.s.devices.get("dev-c")?.key?.publicKey as string };
    await expect(a.keys.removeDevices(["dev-c"], PASSWORD)).rejects.toMatchObject({
      failure: "device-key",
    });
    expect(server.s.bundle?.bundle.kid).toBe(1);
    expect(server.s.devices.has("dev-c")).toBe(true);
  });

  test("a reset without the password waits, can be called off, and its device removed without the password", async () => {
    const { server, a, b } = await threeDevices();
    await b.keys.reset(OTHER);
    expect(server.s.bundle?.bundle.kid).toBe(1);
    await a.keys.refresh();
    expect(a.keys.state()).toMatchObject({
      status: "unlocked",
      kid: 1,
      pendingReset: { deviceId: "dev-b", appliesAt: 1_000 + RESET_DELAY_MS },
    });
    expect(b.keys.state()).toMatchObject({ pendingReset: { deviceId: "dev-b", self: true } });
    await expect(b.keys.reset(OTHER)).rejects.toMatchObject({ failure: "reset-pending" });
    await expect(a.keys.cancelReset(OTHER)).rejects.toMatchObject({ failure: "wrong-password" });
    await a.keys.cancelReset(PASSWORD);
    expect(server.s.pending).toBeNull();
    // Again; this time the owner removes the device that asked, without the password.
    await b.keys.reset(OTHER);
    await a.keys.refresh();
    await a.keys.removeDevices(["dev-b"]);
    expect(server.s.deletes).toEqual(["dev-b"]);
    expect(server.s.pending).toBeNull();
    // Another device still needs the password.
    await expect(a.keys.removeDevices(["dev-c"])).rejects.toMatchObject({
      failure: "wrong-password",
    });
  });

  test("the proof for deleting the account, only where the server keeps a verifier", async () => {
    const { server, a } = await threeDevices();
    const headers = await a.keys.proofHeaders(PASSWORD);
    expect(sha(headers?.[ACCOUNT_AUTH_HEADER] as string)).toBe(server.s.verifier as string);
    await expect(a.keys.proofHeaders(OTHER)).rejects.toMatchObject({ failure: "wrong-password" });
    server.s.verifier = null;
    await a.keys.refresh();
    expect(await a.keys.proofHeaders(PASSWORD)).toBeNull();
  });

  test("a key handed over by pairing is taken, and this device's key registered under it", async () => {
    const { server, a } = await threeDevices();
    const n = device(server, "dev-n");
    await n.keys.restore();
    expect(n.keys.state()).toMatchObject({ status: "locked", kid: 1 });
    await n.keys.adopt(1, a.keys.key()?.key as Uint8Array);
    expect(n.keys.state()).toMatchObject({ status: "unlocked", kid: 1 });
    expect(server.s.devices.get("dev-n")?.key?.kid).toBe(1);
  });
});
