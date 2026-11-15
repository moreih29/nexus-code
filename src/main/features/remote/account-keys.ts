/**
 * This device's hold on the account key: whether the account has one,
 * whether this device holds it, and the account password's flows (set it
 * first, type it on another device, change it, reset it when it is
 * forgotten), against the server's locked bundle (ACCOUNT_KEYS.md).
 *
 * It also keeps this device's key pair registered, takes a new account key
 * from an envelope after another device rotated it, rotates it when it
 * removes a device, and gives the server the password's proof where it asks.
 */
import { z } from "zod";
import {
  ACCOUNT_AUTH_ERROR,
  ACCOUNT_AUTH_HEADER,
  Base64UrlSchema,
  type DeviceKey,
  DeviceKeySchema,
  type KeyBundle,
  type KeyBundleResponse,
  KeyBundleResponseSchema,
  type KeyEnvelope,
  KeyEnvelopesResponseSchema,
  type KeyRotation,
} from "../../../../packages/remote-protocol/src";
import type {
  AccountKeyState,
  KeyFailure,
  RemoteAccountState,
} from "../../../shared/remote/account";
import {
  fromBase64Url,
  KdfTooHeavyError,
  lockAccountKey,
  newAccountKey,
  type PasswordProof,
  passwordLongEnough,
  toBase64Url,
  unlockAccountKey,
  WrongPasswordError,
} from "./account-key";
import {
  certChecks,
  certOf,
  type DeviceKeyPair,
  newDeviceKeyPair,
  openEnvelope,
  sealEnvelope,
} from "./device-key";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import type { Kept } from "./sealed-file";

const BUNDLE_PATH = "/account/key-bundle";

/** The account key as this device keeps it, sealed: whose, and which version. */
export const SavedKeySchema = z.object({
  userId: z.string(),
  kid: z.number().int().positive(),
  key: Base64UrlSchema,
  /** This device's X25519 key pair (account keys v2), made once it held the key. */
  device: z.object({ secretKey: Base64UrlSchema, publicKey: Base64UrlSchema }).optional(),
  /** The key version its public key was last registered with on the server. */
  registered: z.number().int().optional(),
});
export type SavedKey = z.infer<typeof SavedKeySchema>;

/** A flow that did not go through, and why. */
export class KeyError extends Error {
  constructor(
    readonly failure: KeyFailure,
    /** When the server asked to be asked again, in Unix ms. */
    readonly retryAt?: number,
  ) {
    super(`the account key: ${failure}`);
  }
}

export interface AccountKeysDeps {
  readonly account: {
    state(): RemoteAccountState;
    request(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<unknown>;
  };
  readonly store: Kept<SavedKey>;
  onChange?(state: AccountKeyState): void;
  /** Argon2id's cost for new bundles; tests lower it. */
  readonly kdf?: { ops: number; mem: number };
  readonly now?: () => number;
}

/** A device of the account with its key, as GET /devices tells it. */
const KeyedDevicesSchema = z.object({
  devices: z.array(
    z.object({ id: z.string(), key: DeviceKeySchema.nullable().optional() }).passthrough(),
  ),
});

/** What the server said of the account key the last time it was asked. */
interface ServerSide {
  readonly kid: number;
  readonly pendingReset: { appliesAt: number; deviceId: string } | null;
}

export class AccountKeys {
  private held: SavedKey | null = null;
  private server: ServerSide | null = null;
  private current: AccountKeyState = { status: "signed-out" };
  /** One flow at a time: each waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AccountKeysDeps) {}

  state(): AccountKeyState {
    return this.current;
  }

  /** The key, while this device holds the account's current one. */
  key(): { kid: number; key: Uint8Array } | null {
    if (this.current.status !== "unlocked" || !this.held) return null;
    return { kid: this.held.kid, key: fromBase64Url(this.held.key) };
  }

  /**
   * Picks up the key kept from the last run; then asks the server where it
   * stands, which the returned promise waits for (the app does not).
   */
  async restore(): Promise<void> {
    this.held = await this.deps.store.load();
    await this.accountChanged(this.deps.account.state()).catch(() => {});
  }

  /** The account signed in, or out: a key is only ever its own user's. */
  accountChanged(account: RemoteAccountState): Promise<AccountKeyState> {
    return this.run(async () => {
      if (account.status !== "signed-in") {
        if (account.status === "signed-out") {
          // Signed out: this device leaves the account, key and all.
          this.forget();
          this.set({ status: "signed-out" });
        }
        return this.current;
      }
      if (this.held && this.held.userId !== account.user.id) this.forget();
      return this.check();
    });
  }

  /** Asks the server again whether the account has a key, and which. */
  refresh(): Promise<AccountKeyState> {
    return this.run(() => this.check());
  }

  /** The first device: sets the account password, with a new key (version 1). */
  create(password: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      mustBeLongEnough(password);
      const key = await newAccountKey();
      const kid = 1;
      const { bundle, proof } = await this.lock(key, kid, password, userId);
      await this.put(bundle, null, proof);
      await this.hold(userId, kid, key);
      return this.check();
    });
  }

  /** Another device: types the account password to take the key. */
  unlock(password: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      const found = await this.fetch();
      if (!found || this.older(found)) throw await this.conflict();
      const { key } = await this.open(found.bundle, password, userId);
      await this.hold(userId, found.bundle.kid, key);
      return this.check();
    });
  }

  /**
   * A device of a pairing handed this one the account key (version `kid`):
   * taken when it is the account's current one, or newer than the one held.
   */
  adopt(kid: number, key: Uint8Array): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      if (this.held && this.held.kid > kid) throw new KeyError("conflict");
      await this.hold(userId, kid, key);
      return this.check();
    });
  }

  /** Locks the same key with a new password, once the current one is typed again. */
  changePassword(currentPassword: string, nextPassword: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      mustBeLongEnough(nextPassword);
      const found = await this.fetch();
      if (!found || this.older(found)) throw await this.conflict();
      const opened = await this.open(found.bundle, currentPassword, userId);
      const { bundle, proof } = await this.lock(opened.key, found.bundle.kid, nextPassword, userId);
      await this.put(bundle, found.version, proof, opened.proof);
      await this.hold(userId, found.bundle.kid, opened.key);
      return this.check();
    });
  }

  /**
   * The password is forgotten: a new key (the next version) under a new
   * password. It waits (RESET_DELAY_MS), and the devices that know the
   * password may call it off; an account with no key yet has it at once.
   * The account's other devices ask for the new password once they find
   * the new version.
   */
  reset(nextPassword: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      mustBeLongEnough(nextPassword);
      const found = await this.fetch();
      const kid = Math.max(found?.bundle.kid ?? 0, this.held?.kid ?? 0) + 1;
      const key = await newAccountKey();
      const { bundle, proof } = await this.lock(key, kid, nextPassword, userId);
      if (found) {
        try {
          await this.deps.account.request("POST", "/account/key-reset", {
            bundle,
            verifier: proof.verifier,
          });
        } catch (error) {
          if (error instanceof ServerError && error.status === 409) {
            throw new KeyError("reset-pending");
          }
          throw error;
        }
        return this.check();
      }
      await this.put(bundle, null, proof);
      await this.hold(userId, kid, key);
      return this.check();
    });
  }

  /** Calls off a reset that waits, with the password. */
  cancelReset(password: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      const found = await this.fetch();
      if (!found) throw await this.conflict();
      const { proof } = await this.open(found.bundle, password, userId);
      await this.withProof(() =>
        this.deps.account.request("DELETE", "/account/key-reset", undefined, authHeader(proof)),
      );
      return this.check();
    });
  }

  /** The password's proof for the bundle now, as DELETE /account takes it; null with no bundle. */
  proofHeaders(password: string): Promise<Record<string, string> | null> {
    return this.run(async () => {
      const userId = this.userId();
      const found = await this.fetch();
      if (!found) return null;
      const { proof } = await this.open(found.bundle, password, userId);
      return authHeader(proof);
    });
  }

  /**
   * Removes other devices of the account. The key is rotated with them,
   * with the password: the devices that stay get the new key sealed for
   * each, the removed ones do not. The device that asked for a reset that
   * waits may be removed without it, which calls the reset off; with no
   * key yet, the server only ends their sign-ins. This device signs out
   * through the account, not here.
   */
  removeDevices(ids: readonly string[], password?: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const self = this.deviceId();
      const others = ids.filter((id) => id !== self);
      const found = await this.fetch();
      const resetter = found?.pendingReset?.deviceId;
      if (!found || (password === undefined && others.every((id) => id === resetter))) {
        for (const id of others) await this.deleteDevice(id);
        return this.check();
      }
      if (password === undefined) throw new KeyError("wrong-password");
      if (this.older(found)) throw await this.conflict();
      await this.rotate(found, others, password);
      return this.check();
    });
  }

  private async rotate(
    found: KeyBundleResponse,
    remove: readonly string[],
    password: string,
  ): Promise<void> {
    const userId = this.userId();
    const self = this.deviceId();
    const k = found.bundle.kid;
    const opened = await this.open(found.bundle, password, userId);
    // The bundle's key is the current one, held here or not: this device rotates from it.
    if (!this.held || this.held.kid !== k || this.held.key !== toBase64Url(opened.key)) {
      await this.hold(userId, k, opened.key);
    }
    const pair = await this.devicePair();
    const selfKey: DeviceKey = {
      publicKey: pair.publicKey,
      kid: k,
      cert: certOf(opened.key, { userId, deviceId: self, publicKey: pair.publicKey, kid: k }),
    };
    // The server takes the envelopes only from a key it keeps for this device, of version k.
    if (this.held?.registered !== k) await this.register(selfKey);
    const devices = KeyedDevicesSchema.parse(
      await this.deps.account.request("GET", "/devices"),
    ).devices;
    const next = await newAccountKey();
    const locked = await this.lock(next, k + 1, password, userId);
    const certFor = (deviceId: string, publicKey: string) => ({
      deviceId,
      publicKey,
      kid: k + 1,
      cert: certOf(next, { userId, deviceId, publicKey, kid: k + 1 }),
    });
    const envelopes: { deviceId: string; envelope: KeyEnvelope }[] = [];
    const certs = [certFor(self, pair.publicKey)];
    for (const device of devices) {
      if (device.id === self || remove.includes(device.id)) continue;
      // A device with an older key, or none, asks for the password, as before v2.
      if (!device.key || device.key.kid !== k) continue;
      if (!certChecks(opened.key, userId, device.id, device.key)) {
        console.warn(`[remote] device ${device.id}'s key does not check; the key was not rotated`);
        throw new KeyError("device-key");
      }
      envelopes.push({
        deviceId: device.id,
        envelope: await sealEnvelope({
          userId,
          key: next,
          kid: k + 1,
          from: { id: self, secretKey: pair.secretKey, key: selfKey },
          to: { id: device.id, publicKey: device.key.publicKey },
        }),
      });
      certs.push(certFor(device.id, device.key.publicKey));
    }
    const rotation: KeyRotation = {
      bundle: locked.bundle,
      expected: found.version,
      verifier: locked.proof.verifier,
      removeDeviceIds: [...remove],
      envelopes,
      certs,
    };
    try {
      await this.withProof(() =>
        this.deps.account.request(
          "POST",
          "/account/key-rotation",
          rotation,
          authHeader(opened.proof),
        ),
      );
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) throw await this.conflict();
      throw error;
    }
    await this.hold(userId, k + 1, next, k + 1);
  }

  private async deleteDevice(id: string, headers?: Record<string, string>): Promise<void> {
    await this.deps.account.request(
      "DELETE",
      `/devices/${encodeURIComponent(id)}`,
      undefined,
      headers,
    );
  }

  private async check(): Promise<AccountKeyState> {
    if (this.deps.account.state().status !== "signed-in") {
      this.set({ status: "signed-out" });
      return this.current;
    }
    // A key this device holds is used at once: the server only says whether it is still the current one.
    if (this.held) this.set({ status: "unlocked", kid: this.held.kid, ...this.extras() });
    else this.set({ status: "checking" });
    try {
      const found = await this.fetch();
      if (found && this.held && found.bundle.kid > this.held.kid) {
        // Another device rotated the key: an envelope may carry it here.
        await this.takeEnvelopes().catch((error: unknown) =>
          console.warn("[remote] taking the new account key from an envelope failed:", error),
        );
      }
      if (!found) this.set({ status: "missing" });
      else if (this.held?.kid === found.bundle.kid) {
        this.set({ status: "unlocked", kid: found.bundle.kid, ...this.extras() });
        await this.syncDeviceKey().catch((error: unknown) =>
          console.warn("[remote] registering this device's key failed:", error),
        );
      } else if (this.held && this.older(found)) {
        // A key older than the one held: the server went back, or is made to. The newer key stays.
        console.warn(
          `[remote] the server's account key (version ${found.bundle.kid}) is older than this device's (${this.held.kid}); kept this one`,
        );
        this.set({ status: "unlocked", kid: this.held.kid, ...this.extras() });
      } else this.set({ status: "locked", kid: found.bundle.kid, ...this.extras() });
    } catch (error) {
      const failure = keyErrorOf(error, this.now());
      if (failure.failure === "signed-out") this.set({ status: "signed-out" });
      // The server could not say: the key held stays in use until it says otherwise.
      else if (!this.held)
        this.set({
          status: "unavailable",
          ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
        });
    }
    return this.current;
  }

  /** What the server said beside the key: a reset that waits. */
  private extras(): { pendingReset?: AccountKeyStatePending } {
    const server = this.server;
    if (!server) return {};
    const self = this.deps.account.state();
    const selfId = self.status === "signed-in" ? self.device.id : undefined;
    return {
      ...(server.pendingReset
        ? {
            pendingReset: {
              ...server.pendingReset,
              ...(server.pendingReset.deviceId === selfId ? { self: true } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Takes the account keys after the one held from this device's envelopes,
   * in order: each only from a device the key before it vouches for.
   */
  private async takeEnvelopes(): Promise<void> {
    const held = this.held;
    if (!held?.device) return;
    const { envelopes } = KeyEnvelopesResponseSchema.parse(
      await this.deps.account.request("GET", "/devices/current/key-envelopes"),
    );
    let current = { kid: held.kid, key: fromBase64Url(held.key) };
    for (const envelope of [...envelopes].sort((a, b) => a.kid - b.kid)) {
      if (envelope.kid <= current.kid) continue;
      const key = await openEnvelope({
        userId: held.userId,
        envelope,
        self: { id: this.deviceId(), secretKey: held.device.secretKey },
        held: current,
      });
      if (!key) {
        console.warn(`[remote] an envelope of key version ${envelope.kid} did not open`);
        break;
      }
      current = { kid: envelope.kid, key };
    }
    // The rotation vouched for this device's key under the version it carried.
    if (current.kid > held.kid) await this.hold(held.userId, current.kid, current.key, current.kid);
  }

  /** Registers this device's key under the key held, where the server has not it yet. */
  private async syncDeviceKey(): Promise<void> {
    const held = this.held;
    if (!held || held.registered === held.kid) return;
    const pair = await this.devicePair();
    await this.register({
      publicKey: pair.publicKey,
      kid: held.kid,
      cert: certOf(fromBase64Url(held.key), {
        userId: held.userId,
        deviceId: this.deviceId(),
        publicKey: pair.publicKey,
        kid: held.kid,
      }),
    });
  }

  private async register(key: DeviceKey): Promise<void> {
    try {
      await this.deps.account.request("PUT", "/devices/current/key", key);
    } catch (error) {
      // 409 stale: a rotation vouched for this key under a newer version already.
      if (!(error instanceof ServerError && error.status === 409)) throw error;
    }
    if (this.held) {
      this.held = { ...this.held, registered: key.kid };
      await this.deps.store.save(this.held);
    }
  }

  /** This device's key pair, made the first time. */
  private async devicePair(): Promise<DeviceKeyPair> {
    if (!this.held) throw new KeyError("conflict");
    if (this.held.device) return this.held.device;
    const pair = await newDeviceKeyPair();
    this.held = { ...this.held, device: pair };
    await this.deps.store.save(this.held);
    return pair;
  }

  /**
   * Whether the server's bundle is of a version older than the key this
   * device holds: a key is only ever replaced by a newer one (a reset), so
   * an older one is the server going back, which the device does not follow.
   */
  private older(found: KeyBundleResponse): boolean {
    return this.held !== null && found.bundle.kid < this.held.kid;
  }

  /** The bundle on the server, or null before there is one; it notes what the server said. */
  private async fetch(): Promise<KeyBundleResponse | null> {
    try {
      const found = KeyBundleResponseSchema.parse(
        await this.deps.account.request("GET", BUNDLE_PATH),
      );
      this.server = { kid: found.bundle.kid, pendingReset: found.pendingReset ?? null };
      return found;
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) {
        this.server = null;
        return null;
      }
      throw error;
    }
  }

  private async put(
    bundle: KeyBundle,
    expected: number | null,
    fresh: PasswordProof,
    proof?: PasswordProof,
  ): Promise<void> {
    try {
      await this.withProof(() =>
        this.deps.account.request(
          "PUT",
          BUNDLE_PATH,
          { bundle, expected, verifier: fresh.verifier },
          proof ? authHeader(proof) : undefined,
        ),
      );
    } catch (error) {
      // Another device wrote first (or made a newer key): say what it is now.
      if (
        error instanceof ServerError &&
        (error.status === 409 || error.code === "kid_downgrade")
      ) {
        throw await this.conflict();
      }
      throw error;
    }
  }

  /** Runs a request that carries the password's proof: a proof the server does not take is account-auth. */
  private async withProof<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (
        error instanceof ServerError &&
        error.status === 403 &&
        error.code === ACCOUNT_AUTH_ERROR
      ) {
        throw new KeyError("account-auth");
      }
      throw error;
    }
  }

  private async conflict(): Promise<KeyError> {
    await this.check();
    return new KeyError("conflict");
  }

  private lock(key: Uint8Array, kid: number, password: string, userId: string) {
    return lockAccountKey({ key, kid, password, userId, kdf: this.deps.kdf });
  }

  private async open(bundle: KeyBundle, password: string, userId: string) {
    try {
      return await unlockAccountKey(bundle, password, userId);
    } catch (error) {
      if (error instanceof WrongPasswordError) throw new KeyError("wrong-password");
      if (error instanceof KdfTooHeavyError) {
        console.warn(`[remote] ${error.message}`);
        throw new KeyError("too-heavy");
      }
      throw error;
    }
  }

  private async hold(
    userId: string,
    kid: number,
    key: Uint8Array,
    registered?: number,
  ): Promise<void> {
    // The device's key pair stays across key versions; its registration is of one.
    const same = this.held?.userId === userId ? this.held : null;
    const known = registered ?? (same?.kid === kid ? same.registered : undefined);
    this.held = {
      userId,
      kid,
      key: toBase64Url(key),
      ...(same?.device ? { device: same.device } : {}),
      ...(known !== undefined ? { registered: known } : {}),
    };
    await this.deps.store.save(this.held);
    this.set({ status: "unlocked", kid, ...this.extras() });
  }

  private forget(): void {
    this.held = null;
    this.server = null;
    this.deps.store.clear();
  }

  private userId(): string {
    const account = this.deps.account.state();
    if (account.status !== "signed-in") throw new KeyError("signed-out");
    return account.user.id;
  }

  private deviceId(): string {
    const account = this.deps.account.state();
    if (account.status !== "signed-in") throw new KeyError("signed-out");
    return account.device.id;
  }

  private set(next: AccountKeyState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.deps.onChange?.(next);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Runs `flow` after the ones before it; its failure comes back as a KeyError where it is one. */
  private run<T>(flow: () => Promise<T>): Promise<T> {
    const next = this.queue.then(flow).catch((error: unknown) => {
      throw error instanceof KeyError ? error : keyErrorOf(error, this.now(), error);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

type AccountKeyStatePending = { appliesAt: number; deviceId: string; self?: true };

function authHeader(proof: PasswordProof): Record<string, string> {
  return { [ACCOUNT_AUTH_HEADER]: proof.authKey };
}

function mustBeLongEnough(password: string): void {
  if (!passwordLongEnough(password)) throw new KeyError("too-short");
}

/** How a call to the server failed, as the flows tell it; anything else is thrown on. */
function keyErrorOf(error: unknown, now: number, rethrow?: unknown): KeyError {
  if (error instanceof KeyError) return error;
  if (error instanceof SignedOutError) return new KeyError("signed-out");
  if (error instanceof ServerError && error.status === 429) {
    return new KeyError("unavailable", now + (error.retryAfter ?? 60) * 1000);
  }
  // A server that fails, or cannot be reached.
  if ((error instanceof ServerError && error.status >= 500) || error instanceof UnreachableError) {
    return new KeyError("unavailable");
  }
  if (rethrow !== undefined) throw rethrow;
  return new KeyError("unavailable");
}
