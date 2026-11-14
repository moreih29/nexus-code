/**
 * The account key and its locked bundle (packages/remote-protocol's
 * ACCOUNT_KEYS.md): making the key, locking it with the account password
 * for the server to keep, opening it again, and the room key frames are
 * sealed with.
 */
import { hkdfSync } from "node:crypto";
import {
  bundleAadOf,
  DEFAULT_KDF,
  type Kdf,
  type KeyBundle,
  MAX_OPEN_KDF,
  ROOM_KEY_INFO,
} from "../../../../packages/remote-protocol/src";
import { MIN_PASSWORD_LENGTH } from "../../../shared/remote/account";
import { sodium } from "./sodium";

export const ACCOUNT_KEY_BYTES = 32;

/** The password did not open the bundle. */
export class WrongPasswordError extends Error {
  constructor() {
    super("the account password is not right");
  }
}

/** The bundle asks more of Argon2id than this app opens one with (MAX_OPEN_KDF). */
export class KdfTooHeavyError extends Error {
  constructor(kdf: Kdf) {
    super(
      `the account key is locked with heavier settings (Argon2id ops ${kdf.ops}, ${Math.round(kdf.mem / 1024 / 1024)} MiB) than this app opens`,
    );
  }
}

/** The password as the key is made from it: NFKC, so it types the same on every system. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/** Whether the password is long enough, counted in characters as the user sees them. */
export function passwordLongEnough(password: string): boolean {
  return [...normalizePassword(password)].length >= MIN_PASSWORD_LENGTH;
}

export async function newAccountKey(): Promise<Uint8Array> {
  return (await sodium()).randombytes_buf(ACCOUNT_KEY_BYTES);
}

async function passwordKey(password: string, kdf: Kdf): Promise<Uint8Array> {
  const lib = await sodium();
  return lib.crypto_pwhash(
    lib.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    normalizePassword(password),
    fromBase64Url(kdf.salt),
    kdf.ops,
    kdf.mem,
    lib.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Locks `key` (version `kid`) with the password, under a new salt and nonce. */
export async function lockAccountKey(options: {
  key: Uint8Array;
  kid: number;
  password: string;
  userId: string;
  kdf?: { ops: number; mem: number };
}): Promise<KeyBundle> {
  const lib = await sodium();
  const { ops, mem } = options.kdf ?? DEFAULT_KDF;
  const kdf: Kdf = {
    alg: "argon2id13",
    ops,
    mem,
    salt: toBase64Url(lib.randombytes_buf(lib.crypto_pwhash_SALTBYTES)),
  };
  const kek = await passwordKey(options.password, kdf);
  const nonce = lib.randombytes_buf(lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  try {
    const box = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
      options.key,
      bundleAadOf(options.userId, options.kid),
      null,
      nonce,
      kek,
    );
    return { v: 1, kid: options.kid, kdf, nonce: toBase64Url(nonce), box: toBase64Url(box) };
  } finally {
    lib.memzero(kek);
  }
}

/**
 * Opens the bundle with the password; a wrong one throws WrongPasswordError,
 * a bundle past MAX_OPEN_KDF KdfTooHeavyError.
 */
export async function unlockAccountKey(
  bundle: KeyBundle,
  password: string,
  userId: string,
): Promise<Uint8Array> {
  // Argon2id runs on the main process: a bundle that asks too much would hold up the app.
  if (bundle.kdf.ops > MAX_OPEN_KDF.ops || bundle.kdf.mem > MAX_OPEN_KDF.mem) {
    throw new KdfTooHeavyError(bundle.kdf);
  }
  const lib = await sodium();
  const kek = await passwordKey(password, bundle.kdf);
  try {
    const key = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(bundle.box),
      bundleAadOf(userId, bundle.kid),
      fromBase64Url(bundle.nonce),
      kek,
    );
    if (key.length !== ACCOUNT_KEY_BYTES) throw new WrongPasswordError();
    return key;
  } catch {
    // The AEAD check failed: the password is wrong, or the bundle is not this user's.
    throw new WrongPasswordError();
  } finally {
    lib.memzero(kek);
  }
}

/** The key frames are sealed with: HKDF-SHA256 of the account key. */
export function roomKeyOf(key: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", key, new Uint8Array(0), ROOM_KEY_INFO, 32));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}
