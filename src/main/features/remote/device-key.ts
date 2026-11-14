/**
 * Account keys v2 on this device (packages/remote-protocol's
 * ACCOUNT_KEYS.md, "Version 2"): its X25519 key pair, certificates under
 * the account key, envelopes that carry a new account key to one device,
 * and the frames of a pairing through a QR code.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  aadOf,
  DEVICE_CERT_KEY_INFO,
  type DeviceKey,
  deviceCertInputOf,
  envelopeInfoOf,
  type KeyEnvelope,
  PAIR_KID,
  type PairMessage,
  PairMessageSchema,
  pairKeyInfoOf,
} from "../../../../packages/remote-protocol/src";
import { ACCOUNT_KEY_BYTES, fromBase64Url, toBase64Url } from "./account-key";
import { sodium } from "./sodium";

const NONCE_BYTES = 24;

function hkdf(ikm: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, 32));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// The device's key pair
// ---------------------------------------------------------------------------

/** This device's X25519 key pair, base64url. */
export interface DeviceKeyPair {
  readonly secretKey: string;
  readonly publicKey: string;
}

/** A new key pair; `secret` (32 bytes) only for tests. */
export async function newDeviceKeyPair(secret?: Uint8Array): Promise<DeviceKeyPair> {
  const lib = await sodium();
  const secretKey = secret ?? lib.randombytes_buf(lib.crypto_scalarmult_SCALARBYTES);
  return {
    secretKey: toBase64Url(secretKey),
    publicKey: toBase64Url(lib.crypto_scalarmult_base(secretKey)),
  };
}

/** X25519 of one side's secret key and the other's public key; throws on an all-zero secret. */
async function shared(secretKey: string, publicKey: string): Promise<Uint8Array> {
  const lib = await sodium();
  // libsodium refuses a public key that makes an all-zero secret.
  return lib.crypto_scalarmult(fromBase64Url(secretKey), fromBase64Url(publicKey));
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/** Who a certificate is of. */
export interface CertSubject {
  readonly userId: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly kid: number;
}

/** The certificate of `subject` under the account key `accountKey`, which must be of version `subject.kid`. */
export function certOf(accountKey: Uint8Array, subject: CertSubject): string {
  const certKey = hkdf(accountKey, DEVICE_CERT_KEY_INFO);
  return createHmac("sha256", certKey)
    .update(deviceCertInputOf(subject.userId, subject.deviceId, subject.publicKey, subject.kid))
    .digest("base64url");
}

/** Whether `key`, of the device `deviceId`, is vouched for by the account key of its version. */
export function certChecks(
  accountKey: Uint8Array,
  userId: string,
  deviceId: string,
  key: DeviceKey,
): boolean {
  const want = fromBase64Url(
    certOf(accountKey, { userId, deviceId, publicKey: key.publicKey, kid: key.kid }),
  );
  return sameBytes(want, fromBase64Url(key.cert));
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Seals the account key `key` (version `kid`) for the device `to`, from
 * this device `from`, whose key `from.key` is vouched for under version
 * kid - 1. `nonce` only for tests.
 */
export async function sealEnvelope(options: {
  readonly userId: string;
  readonly key: Uint8Array;
  readonly kid: number;
  readonly from: { readonly id: string; readonly secretKey: string; readonly key: DeviceKey };
  readonly to: { readonly id: string; readonly publicKey: string };
  readonly nonce?: Uint8Array;
}): Promise<KeyEnvelope> {
  const lib = await sodium();
  const info = envelopeInfoOf(options.userId, options.from.id, options.to.id, options.kid);
  const secret = await shared(options.from.secretKey, options.to.publicKey);
  const envKey = hkdf(secret, info);
  const nonce = options.nonce ?? lib.randombytes_buf(NONCE_BYTES);
  try {
    const box = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
      options.key,
      info,
      null,
      nonce,
      envKey,
    );
    return {
      v: 1,
      kid: options.kid,
      from: options.from.id,
      fromKey: options.from.key,
      nonce: toBase64Url(nonce),
      box: toBase64Url(box),
    };
  } finally {
    lib.memzero(secret);
    lib.memzero(envKey);
  }
}

/**
 * Opens an envelope for this device `self`, which holds the account key
 * `held`: only one of the version after it, from a device whose key that
 * key vouches for. Null when it is not, or does not open.
 */
export async function openEnvelope(options: {
  readonly userId: string;
  readonly envelope: KeyEnvelope;
  readonly self: { readonly id: string; readonly secretKey: string };
  readonly held: { readonly kid: number; readonly key: Uint8Array };
}): Promise<Uint8Array | null> {
  const { envelope, held, userId } = options;
  if (envelope.kid !== held.kid + 1 || envelope.fromKey.kid !== held.kid) return null;
  if (!certChecks(held.key, userId, envelope.from, envelope.fromKey)) return null;
  const lib = await sodium();
  const info = envelopeInfoOf(userId, envelope.from, options.self.id, envelope.kid);
  let secret: Uint8Array;
  try {
    secret = await shared(options.self.secretKey, envelope.fromKey.publicKey);
  } catch {
    return null;
  }
  const envKey = hkdf(secret, info);
  try {
    const key = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(envelope.box),
      info,
      fromBase64Url(envelope.nonce),
      envKey,
    );
    return key.length === ACCOUNT_KEY_BYTES ? key : null;
  } catch {
    return null;
  } finally {
    lib.memzero(secret);
    lib.memzero(envKey);
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** A new pairing code's secret (32 bytes), base64url. */
export function newPairSecret(): string {
  return toBase64Url(randomBytes(32));
}

/** The key a pairing's frames are sealed with: of the code's secret, the account, and the device showing it. */
export function pairKeyOf(secret: string, userId: string, shownBy: string): Uint8Array {
  return hkdf(fromBase64Url(secret), pairKeyInfoOf(userId, shownBy));
}

/** A pairing frame's routing, as the relay delivers it. */
export interface PairRouting {
  readonly from: string;
  readonly to: string;
  readonly seq: number;
}

/** Seals a pairing message for a relay frame of kid PAIR_KID. `nonce` only for tests. */
export async function sealPair(
  pairKey: Uint8Array,
  routing: PairRouting,
  message: PairMessage,
  nonce?: Uint8Array,
): Promise<{ nonce: string; box: string }> {
  const lib = await sodium();
  const n = nonce ?? lib.randombytes_buf(NONCE_BYTES);
  const box = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    JSON.stringify(message),
    aadOf({ ...routing, kid: PAIR_KID }),
    null,
    n,
    pairKey,
  );
  return { nonce: toBase64Url(n), box: toBase64Url(box) };
}

/** Opens a pairing frame; null when it does not open, or holds no pairing message. */
export async function openPair(
  pairKey: Uint8Array,
  frame: PairRouting & { readonly kid: number; readonly nonce: string; readonly box: string },
): Promise<PairMessage | null> {
  if (frame.kid !== PAIR_KID) return null;
  const lib = await sodium();
  try {
    const bytes = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(frame.box),
      aadOf(frame),
      fromBase64Url(frame.nonce),
      pairKey,
    );
    const parsed = PairMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
