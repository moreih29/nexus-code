/**
 * Account keys v2 (see ../ACCOUNT_KEYS.md): a key pair of each device's,
 * vouched for with the account key; the account key handed to another
 * device through a QR code (pairing) or sealed for each device that stays
 * when one is removed (rotation); and the proof of the account password the
 * server asks before what only the account's owner may do.
 *
 * The server keeps and checks the shapes below. It cannot make a
 * certificate, open an envelope or a pairing frame, or learn the password
 * from its proof.
 */
import { z } from "zod";
import { KeyBundleSchema, VerifierSchema } from "./account.js";
import { Base64UrlSchema, DeviceIdSchema } from "./relay.js";
import { PositiveIntegerSchema } from "./validation.js";

// ---------------------------------------------------------------------------
// The password's proof
// ---------------------------------------------------------------------------

/**
 * The HKDF info that makes the password's proof (authKey) from the key the
 * password makes with a bundle's kdf (KEK).
 */
export const ACCOUNT_AUTH_INFO = "nexus-remote/account-auth/v1";

/**
 * The header that carries authKey (32 bytes, base64url) where the server
 * asks for the password: a bundle's write, a rotation, removing another
 * device, deleting the account, calling off a reset.
 */
export const ACCOUNT_AUTH_HEADER = "X-Account-Auth";

/**
 * What the server answers, with 403, when the header is missing or does
 * not match: `{ "error": ACCOUNT_AUTH_ERROR }`.
 */
export const ACCOUNT_AUTH_ERROR = "account-auth";

// ---------------------------------------------------------------------------
// A forgotten password: a reset that waits
// ---------------------------------------------------------------------------

/** How long a reset asked for without the password waits before it is put in place. */
export const RESET_DELAY_MS = 72 * 60 * 60 * 1000;

/**
 * POST /account/key-reset, without the password: a new key (kid + 1)
 * locked with a new password, which the server puts in place after
 * RESET_DELAY_MS unless a device that knows the password calls it off
 * (DELETE /account/key-reset, with the header). 409 while one waits.
 */
export const KeyResetPostSchema = z.object({
  bundle: KeyBundleSchema,
  verifier: VerifierSchema,
});
export type KeyResetPost = z.infer<typeof KeyResetPostSchema>;

// ---------------------------------------------------------------------------
// Device keys
// ---------------------------------------------------------------------------

/** The HKDF info that makes the key certificates are made with from the account key. */
export const DEVICE_CERT_KEY_INFO = "nexus-remote/device-cert-key/v1";

/**
 * What a device's certificate is the HMAC-SHA256 of: the device, its
 * public key (base64url, as it travels), and the account key's version
 * that vouches for it.
 */
export function deviceCertInputOf(
  userId: string,
  deviceId: string,
  publicKey: string,
  kid: number,
): string {
  return `nexus-remote/device-cert/v1|${userId}|${deviceId}|${publicKey}|${kid}`;
}

/**
 * A device's X25519 public key (32 bytes), and its certificate under the
 * account key of version `kid`: HMAC-SHA256 of deviceCertInputOf with
 * HKDF-SHA256(account key, DEVICE_CERT_KEY_INFO). Only a device holding
 * that account key can make or check it.
 */
export const DeviceKeySchema = z.object({
  publicKey: Base64UrlSchema.length(43),
  kid: PositiveIntegerSchema,
  cert: Base64UrlSchema.length(43),
});
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

/**
 * PUT /devices/current/key: this device's key, when it gets the account
 * key and when its version changes without a rotation vouching for it anew.
 * The server drops this device's envelopes of that version or older.
 */
export const DeviceKeyPutSchema = DeviceKeySchema;
export type DeviceKeyPut = z.infer<typeof DeviceKeyPutSchema>;

// ---------------------------------------------------------------------------
// Envelopes and rotation
// ---------------------------------------------------------------------------

/**
 * The HKDF info, and the associated data, an envelope is sealed with: who
 * seals it for whom, and the account key's version it carries.
 */
export function envelopeInfoOf(userId: string, from: string, to: string, kid: number): string {
  return `nexus-remote/key-envelope/v1|${userId}|${from}|${to}|${kid}`;
}

/**
 * The account key of version `kid` sealed for one device by the device
 * `from`: XChaCha20-Poly1305 of the 32 key bytes under HKDF-SHA256 of
 * X25519(from's secret key, the receiver's public key), with
 * envelopeInfoOf as the info and as the associated data. `fromKey` is the
 * sender's key under the version before (kid - 1), which the receiver
 * checks with the account key it holds before it opens the box.
 */
export const KeyEnvelopeSchema = z.object({
  v: z.literal(1),
  kid: PositiveIntegerSchema,
  from: DeviceIdSchema,
  fromKey: DeviceKeySchema,
  /** 24 random bytes. */
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type KeyEnvelope = z.infer<typeof KeyEnvelopeSchema>;

/** GET /devices/current/key-envelopes: this device's envelopes, oldest version first. */
export const KeyEnvelopesResponseSchema = z.object({
  envelopes: z.array(KeyEnvelopeSchema),
});
export type KeyEnvelopesResponse = z.infer<typeof KeyEnvelopesResponseSchema>;

/**
 * POST /account/key-rotation, with the password's header: a new account
 * key (kid + 1) locked with the password typed now, the devices removed
 * with it, an envelope for each device that stays and holds a key of the
 * version before, and their keys vouched for anew. The server does it all
 * at once or not at all (409 when `expected` is not the bundle's version).
 */
export const KeyRotationSchema = z.object({
  bundle: KeyBundleSchema,
  expected: PositiveIntegerSchema,
  verifier: VerifierSchema,
  removeDeviceIds: z.array(DeviceIdSchema).max(32),
  envelopes: z.array(z.object({ deviceId: DeviceIdSchema, envelope: KeyEnvelopeSchema })).max(32),
  /** Each staying device's key (the rotating one's too) under the new version; its public key as the server has it. */
  certs: z.array(DeviceKeySchema.extend({ deviceId: DeviceIdSchema })).max(32),
});
export type KeyRotation = z.infer<typeof KeyRotationSchema>;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** The kid of a relay frame sealed with a pairing key, not the room key. */
export const PAIR_KID = 0;

/** How long a pairing QR code holds. */
export const PAIR_TTL_MS = 2 * 60 * 1000;

/** The URI a pairing QR code holds. */
export const PAIR_URI_PREFIX = "nexuscode://pair";

/** What a pairing QR code tells: the account, the device showing it, and a one-time secret (32 bytes). */
export const PairCodeSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  deviceId: DeviceIdSchema,
  secret: Base64UrlSchema.length(43),
});
export type PairCode = z.infer<typeof PairCodeSchema>;

/** The text of a pairing QR code: `nexuscode://pair?v=1&u=<userId>&d=<deviceId>&s=<secret>`. */
export function pairUriOf(code: PairCode): string {
  const query = new URLSearchParams({
    v: String(code.v),
    u: code.userId,
    d: code.deviceId,
    s: code.secret,
  });
  return `${PAIR_URI_PREFIX}?${query.toString()}`;
}

/** The pairing code in a QR code's text; null when it holds none. */
export function parsePairUri(text: string): PairCode | null {
  if (!text.startsWith(`${PAIR_URI_PREFIX}?`)) return null;
  const query = new URLSearchParams(text.slice(PAIR_URI_PREFIX.length + 1));
  const parsed = PairCodeSchema.safeParse({
    v: Number(query.get("v")),
    userId: query.get("u"),
    deviceId: query.get("d"),
    secret: query.get("s"),
  });
  return parsed.success ? parsed.data : null;
}

/** The HKDF info that makes a pairing key from a code's secret: the account and the device showing it. */
export function pairKeyInfoOf(userId: string, deviceId: string): string {
  return `nexus-remote/pair-key/v1|${userId}|${deviceId}`;
}

/**
 * What a pairing frame carries, sealed as a message is (XChaCha20-Poly1305,
 * aadOf as associated data, kid PAIR_KID) under HKDF-SHA256(code's secret,
 * pairKeyInfoOf):
 * - pair-request: a device without the account key, which scanned the
 *   code a device holding it shows, asks for it;
 * - pair-key: the account key and its version;
 * - pair-done: the device took it;
 * - pair-refused: the user turned it down, or the code ran out; or the two
 *   devices cannot pair, as both hold the account key or neither does.
 */
export const PairMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("pair-request"), v: z.literal(1) }),
  z.object({
    t: z.literal("pair-key"),
    v: z.literal(1),
    kid: PositiveIntegerSchema,
    key: Base64UrlSchema.length(43),
  }),
  z.object({ t: z.literal("pair-done"), v: z.literal(1) }),
  z.object({ t: z.literal("pair-refused"), v: z.literal(1) }),
]);
export type PairMessage = z.infer<typeof PairMessageSchema>;
