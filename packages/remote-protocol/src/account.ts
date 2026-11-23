import { z } from "zod";
import { Base64UrlSchema, DeviceIdSchema } from "./relay.js";
import { IntegerSchema, PositiveIntegerSchema } from "./validation.js";

export function bundleAadOf(userId: string, kid: number): string {
  return `nexus-remote/account-key/v1|${userId}|${kid}`;
}

export const KdfSchema = z.object({
  alg: z.literal("argon2id13"),
  ops: IntegerSchema.check(z.gte(1)).check(z.lte(10)),
  mem: IntegerSchema.check(z.gte(16 * 1024 * 1024)).check(z.lte(1024 * 1024 * 1024)),
  salt: Base64UrlSchema,
});
export type Kdf = z.infer<typeof KdfSchema>;

export const DEFAULT_KDF = { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024 } as const;

export const MAX_OPEN_KDF = { ops: 4, mem: 256 * 1024 * 1024 } as const;

export const KeyBundleSchema = z.object({
  v: z.literal(1),
  kid: PositiveIntegerSchema,
  kdf: KdfSchema,
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type KeyBundle = z.infer<typeof KeyBundleSchema>;

export const VerifierSchema = Base64UrlSchema.length(43);

export const PendingResetSchema = z.object({
  appliesAt: IntegerSchema,
  deviceId: DeviceIdSchema,
});
export type PendingReset = z.infer<typeof PendingResetSchema>;

export const KeyBundleResponseSchema = z.object({
  bundle: KeyBundleSchema,
  version: PositiveIntegerSchema,
  pendingReset: PendingResetSchema.nullable().optional(),
});
export type KeyBundleResponse = z.infer<typeof KeyBundleResponseSchema>;

export const KeyBundlePutSchema = z.object({
  bundle: KeyBundleSchema,
  expected: PositiveIntegerSchema.nullable(),
  verifier: VerifierSchema,
});
export type KeyBundlePut = z.infer<typeof KeyBundlePutSchema>;
