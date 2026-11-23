import { z } from "zod";
import { KeyBundleSchema, VerifierSchema } from "./account.js";
import { Base64UrlSchema, DeviceIdSchema } from "./relay.js";
import { PositiveIntegerSchema } from "./validation.js";

export const ACCOUNT_AUTH_INFO = "nexus-remote/account-auth/v1";

export const ACCOUNT_AUTH_HEADER = "X-Account-Auth";

export const ACCOUNT_AUTH_ERROR = "account-auth";

export const RESET_DELAY_MS = 72 * 60 * 60 * 1000;

export const KeyResetPostSchema = z.object({
  bundle: KeyBundleSchema,
  verifier: VerifierSchema,
});
export type KeyResetPost = z.infer<typeof KeyResetPostSchema>;

export const DEVICE_CERT_KEY_INFO = "nexus-remote/device-cert-key/v1";

export function deviceCertInputOf(
  userId: string,
  deviceId: string,
  publicKey: string,
  kid: number,
): string {
  return `nexus-remote/device-cert/v1|${userId}|${deviceId}|${publicKey}|${kid}`;
}

export const DeviceKeySchema = z.object({
  publicKey: Base64UrlSchema.length(43),
  kid: PositiveIntegerSchema,
  cert: Base64UrlSchema.length(43),
});
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

export const DeviceKeyPutSchema = DeviceKeySchema;
export type DeviceKeyPut = z.infer<typeof DeviceKeyPutSchema>;

export function envelopeInfoOf(userId: string, from: string, to: string, kid: number): string {
  return `nexus-remote/key-envelope/v1|${userId}|${from}|${to}|${kid}`;
}

export const KeyEnvelopeSchema = z.object({
  v: z.literal(1),
  kid: PositiveIntegerSchema,
  from: DeviceIdSchema,
  fromKey: DeviceKeySchema,
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type KeyEnvelope = z.infer<typeof KeyEnvelopeSchema>;

export const KeyEnvelopesResponseSchema = z.object({
  envelopes: z.array(KeyEnvelopeSchema),
});
export type KeyEnvelopesResponse = z.infer<typeof KeyEnvelopesResponseSchema>;

export const KeyRotationSchema = z.object({
  bundle: KeyBundleSchema,
  expected: PositiveIntegerSchema,
  verifier: VerifierSchema,
  removeDeviceIds: z.array(DeviceIdSchema).max(32),
  envelopes: z.array(z.object({ deviceId: DeviceIdSchema, envelope: KeyEnvelopeSchema })).max(32),
  certs: z.array(DeviceKeySchema.extend({ deviceId: DeviceIdSchema })).max(32),
});
export type KeyRotation = z.infer<typeof KeyRotationSchema>;

export const PAIR_KID = 0;

export const PAIR_TTL_MS = 2 * 60 * 1000;

export const PAIR_URI_PREFIX = "nexuscode://pair";

export const PairCodeSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  deviceId: DeviceIdSchema,
  secret: Base64UrlSchema.length(43),
});
export type PairCode = z.infer<typeof PairCodeSchema>;

export function pairUriOf(code: PairCode): string {
  const query = new URLSearchParams({
    v: String(code.v),
    u: code.userId,
    d: code.deviceId,
    s: code.secret,
  });
  return `${PAIR_URI_PREFIX}?${query.toString()}`;
}

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

export function pairKeyInfoOf(userId: string, deviceId: string): string {
  return `nexus-remote/pair-key/v1|${userId}|${deviceId}`;
}

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
