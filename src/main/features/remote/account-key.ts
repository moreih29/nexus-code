import { createHash, hkdfSync } from "node:crypto";
import {
  ACCOUNT_AUTH_INFO,
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

export class WrongPasswordError extends Error {
  constructor() {
    super("the account password is not right");
  }
}

export class KdfTooHeavyError extends Error {
  constructor(kdf: Kdf) {
    super(
      `the account key is locked with heavier settings (Argon2id ops ${kdf.ops}, ${Math.round(kdf.mem / 1024 / 1024)} MiB) than this app opens`,
    );
  }
}

export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

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

export interface PasswordProof {
  readonly authKey: string;
  readonly verifier: string;
}

export function passwordProofOf(kek: Uint8Array): PasswordProof {
  const authKey = new Uint8Array(hkdfSync("sha256", kek, new Uint8Array(0), ACCOUNT_AUTH_INFO, 32));
  return {
    authKey: toBase64Url(authKey),
    verifier: createHash("sha256").update(authKey).digest("base64url"),
  };
}

export async function lockAccountKey(options: {
  key: Uint8Array;
  kid: number;
  password: string;
  userId: string;
  kdf?: { ops: number; mem: number };
}): Promise<{ bundle: KeyBundle; proof: PasswordProof }> {
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
    return {
      bundle: { v: 1, kid: options.kid, kdf, nonce: toBase64Url(nonce), box: toBase64Url(box) },
      proof: passwordProofOf(kek),
    };
  } finally {
    lib.memzero(kek);
  }
}

export async function unlockAccountKey(
  bundle: KeyBundle,
  password: string,
  userId: string,
): Promise<{ key: Uint8Array; proof: PasswordProof }> {
  if (bundle.kdf.ops > MAX_OPEN_KDF.ops || bundle.kdf.mem > MAX_OPEN_KDF.mem) {
    throw new KdfTooHeavyError(bundle.kdf);
  }
  const lib = await sodium();
  const kek = await passwordKey(password, bundle.kdf);
  let key: Uint8Array;
  try {
    key = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(bundle.box),
      bundleAadOf(userId, bundle.kid),
      fromBase64Url(bundle.nonce),
      kek,
    );
    if (key.length !== ACCOUNT_KEY_BYTES) throw new WrongPasswordError();
  } catch {
    lib.memzero(kek);
    throw new WrongPasswordError();
  }
  try {
    return { key, proof: passwordProofOf(kek) };
  } finally {
    lib.memzero(kek);
  }
}

export function roomKeyOf(key: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", key, new Uint8Array(0), ROOM_KEY_INFO, 32));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}
