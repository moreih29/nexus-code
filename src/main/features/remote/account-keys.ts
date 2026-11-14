/**
 * This device's hold on the account key: whether the account has one,
 * whether this device holds it, and the account password's flows (set it
 * first, type it on another device, change it, reset it when it is
 * forgotten), against the server's locked bundle (ACCOUNT_KEYS.md).
 */
import { z } from "zod";
import {
  Base64UrlSchema,
  type KeyBundle,
  type KeyBundleResponse,
  KeyBundleResponseSchema,
} from "../../../../packages/remote-protocol/src";
import type {
  AccountKeyState,
  KeyFailure,
  RemoteAccountState,
} from "../../../shared/remote/account";
import {
  fromBase64Url,
  lockAccountKey,
  newAccountKey,
  passwordLongEnough,
  toBase64Url,
  unlockAccountKey,
  WrongPasswordError,
} from "./account-key";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import type { Kept } from "./sealed-file";

const BUNDLE_PATH = "/account/key-bundle";

/** The account key as this device keeps it, sealed: whose, and which version. */
export const SavedKeySchema = z.object({
  userId: z.string(),
  kid: z.number().int().positive(),
  key: Base64UrlSchema,
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
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  };
  readonly store: Kept<SavedKey>;
  onChange?(state: AccountKeyState): void;
  /** Argon2id's cost for new bundles; tests lower it. */
  readonly kdf?: { ops: number; mem: number };
  readonly now?: () => number;
}

export class AccountKeys {
  private held: SavedKey | null = null;
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
      const bundle = await this.lock(key, kid, password, userId);
      await this.put(bundle, null);
      return this.hold(userId, kid, key);
    });
  }

  /** Another device: types the account password to take the key. */
  unlock(password: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      const found = await this.fetch();
      if (!found || this.older(found)) throw await this.conflict();
      const key = await this.open(found.bundle, password, userId);
      return this.hold(userId, found.bundle.kid, key);
    });
  }

  /** Locks the same key with a new password, once the current one is typed again. */
  changePassword(currentPassword: string, nextPassword: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      mustBeLongEnough(nextPassword);
      const found = await this.fetch();
      if (!found || this.older(found)) throw await this.conflict();
      const key = await this.open(found.bundle, currentPassword, userId);
      const bundle = await this.lock(key, found.bundle.kid, nextPassword, userId);
      await this.put(bundle, found.version);
      return this.hold(userId, found.bundle.kid, key);
    });
  }

  /**
   * The password is forgotten, or a device was lost: a new key (the next
   * version) under a new password. The account's other devices ask for it
   * once they find the new version.
   */
  reset(nextPassword: string): Promise<AccountKeyState> {
    return this.run(async () => {
      const userId = this.userId();
      mustBeLongEnough(nextPassword);
      const found = await this.fetch();
      const kid = Math.max(found?.bundle.kid ?? 0, this.held?.kid ?? 0) + 1;
      const key = await newAccountKey();
      const bundle = await this.lock(key, kid, nextPassword, userId);
      await this.put(bundle, found?.version ?? null);
      return this.hold(userId, kid, key);
    });
  }

  private async check(): Promise<AccountKeyState> {
    if (this.deps.account.state().status !== "signed-in") {
      this.set({ status: "signed-out" });
      return this.current;
    }
    // A key this device holds is used at once: the server only says whether it is still the current one.
    if (this.held) this.set({ status: "unlocked", kid: this.held.kid });
    else this.set({ status: "checking" });
    try {
      const found = await this.fetch();
      if (!found) this.set({ status: "missing" });
      else if (this.held?.kid === found.bundle.kid)
        this.set({ status: "unlocked", kid: found.bundle.kid });
      else if (this.held && this.older(found)) {
        // A key older than the one held: the server went back, or is made to. The newer key stays.
        console.warn(
          `[remote] the server's account key (version ${found.bundle.kid}) is older than this device's (${this.held.kid}); kept this one`,
        );
        this.set({ status: "unlocked", kid: this.held.kid });
      } else this.set({ status: "locked", kid: found.bundle.kid });
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

  /**
   * Whether the server's bundle is of a version older than the key this
   * device holds: a key is only ever replaced by a newer one (a reset), so
   * an older one is the server going back, which the device does not follow.
   */
  private older(found: KeyBundleResponse): boolean {
    return this.held !== null && found.bundle.kid < this.held.kid;
  }

  /** The bundle on the server, or null before there is one. */
  private async fetch(): Promise<KeyBundleResponse | null> {
    try {
      return KeyBundleResponseSchema.parse(await this.deps.account.request("GET", BUNDLE_PATH));
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return null;
      throw error;
    }
  }

  private async put(bundle: KeyBundle, expected: number | null): Promise<void> {
    try {
      await this.deps.account.request("PUT", BUNDLE_PATH, { bundle, expected });
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

  private async conflict(): Promise<KeyError> {
    await this.check();
    return new KeyError("conflict");
  }

  private lock(key: Uint8Array, kid: number, password: string, userId: string) {
    return lockAccountKey({ key, kid, password, userId, kdf: this.deps.kdf });
  }

  private async open(bundle: KeyBundle, password: string, userId: string): Promise<Uint8Array> {
    try {
      return await unlockAccountKey(bundle, password, userId);
    } catch (error) {
      if (error instanceof WrongPasswordError) throw new KeyError("wrong-password");
      throw error;
    }
  }

  private async hold(userId: string, kid: number, key: Uint8Array): Promise<AccountKeyState> {
    this.held = { userId, kid, key: toBase64Url(key) };
    await this.deps.store.save(this.held);
    this.set({ status: "unlocked", kid });
    return this.current;
  }

  private forget(): void {
    this.held = null;
    this.deps.store.clear();
  }

  private userId(): string {
    const account = this.deps.account.state();
    if (account.status !== "signed-in") throw new KeyError("signed-out");
    return account.user.id;
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
