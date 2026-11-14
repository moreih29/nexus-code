/**
 * The account key, locked with the account password: the server keeps the
 * locked bundle and hands it to the account's devices, which open it on
 * their own (see ../ACCOUNT_KEYS.md). The server never sees the password,
 * the key, or anything made from them; it only checks the bundle's shape.
 */
import { z } from "zod";
import { Base64UrlSchema } from "./relay.js";

/** The associated data the key is sealed with: the user's id and the key's version, so a bundle cannot pass for another's. */
export function bundleAadOf(userId: string, kid: number): string {
  return `nexus-remote/account-key/v1|${userId}|${kid}`;
}

/** Argon2id's settings, as libsodium's crypto_pwhash takes them (ALG_ARGON2ID13). */
export const KdfSchema = z.object({
  alg: z.literal("argon2id13"),
  /** crypto_pwhash's opslimit. */
  ops: z.number().int().min(1).max(10),
  /** crypto_pwhash's memlimit, in bytes. */
  mem: z
    .number()
    .int()
    .min(16 * 1024 * 1024)
    .max(1024 * 1024 * 1024),
  /** 16 random bytes. */
  salt: Base64UrlSchema,
});
export type Kdf = z.infer<typeof KdfSchema>;

/** The settings a new bundle is locked with; a bundle keeps its own, so these can grow. */
export const DEFAULT_KDF = { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024 } as const;

/**
 * The heaviest settings a device opens a bundle with, DEFAULT_KDF's room to
 * grow. KdfSchema takes more, for bundles locked so already; but a bundle
 * past these, as a server could hand out, would hold up the device for long
 * while it unlocks, so a device says it cannot open it instead.
 */
export const MAX_OPEN_KDF = { ops: 4, mem: 256 * 1024 * 1024 } as const;

/**
 * The account key (32 bytes) sealed with XChaCha20-Poly1305 under the key
 * the password makes with `kdf`, with bundleAadOf(userId, kid) as the
 * associated data. `kid` is the account key's version, which sealed frames
 * name; it goes up when the key is made anew.
 */
export const KeyBundleSchema = z.object({
  v: z.literal(1),
  kid: z.number().int().positive(),
  kdf: KdfSchema,
  /** 24 random bytes. */
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type KeyBundle = z.infer<typeof KeyBundleSchema>;

/** GET /account/key-bundle: the bundle and its version on the server, or 404 before there is one. */
export const KeyBundleResponseSchema = z.object({
  bundle: KeyBundleSchema,
  /** Counts the bundle's writes, for the next PUT to say which one it replaces. */
  version: z.number().int().positive(),
});
export type KeyBundleResponse = z.infer<typeof KeyBundleResponseSchema>;

/**
 * PUT /account/key-bundle. `expected` is the version it replaces, or null
 * for the first bundle; the server answers 409 when another write came
 * first. A new password locks the same key (same kid); a reset puts a new
 * key (kid + 1), which the account's other devices take once they are told
 * the new password.
 */
export const KeyBundlePutSchema = z.object({
  bundle: KeyBundleSchema,
  expected: z.number().int().positive().nullable(),
});
export type KeyBundlePut = z.infer<typeof KeyBundlePutSchema>;
