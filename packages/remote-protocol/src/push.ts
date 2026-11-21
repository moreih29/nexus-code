/**
 * The push API: a phone registers its APNs token and a computer asks the
 * server to notify the account's phones when something waits on the user.
 *
 * PUT /push/registration?v=1 returns 204. Its errors are `bad_request`,
 * `unsupported_environment`, `unsupported_version` (400), and `not_a_phone`
 * (403). DELETE /push/registration clears the registration and returns 204.
 * POST /push/send?v=1 returns a PushSendResult (200). Its errors are
 * `bad_request`, `unsupported_version` (400), and `not_a_computer` (403).
 * Registration and send may also return 429 when rate limited.
 */
import { z } from "zod";
import { DeviceIdSchema } from "./relay.js";

export const PUSH_VERSION = 1;

export const PushKindSchema = z.enum(["consent", "request", "result"]);
export type PushKind = z.infer<typeof PushKindSchema>;

/** A computer makes 22 base64url characters from 16 random bytes and keeps the same id on retries. */
export const PUSH_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,43}$/;

/** The server clamps each notification's TTL to its kind's range, in seconds. */
export const PUSH_TTL_SECONDS = {
  consent: { min: 5, max: 120 },
  request: { min: 5, max: 900 },
  result: { min: 5, max: 1800 },
} as const;

/** PUT /push/registration?v=1: a phone's token and the notifications it wants. */
export const PushRegistrationSchema = z.object({
  service: z.literal("apns"),
  token: z.string().regex(/^[a-f0-9]{32,512}$/),
  environment: z.enum(["production", "sandbox"]),
  locale: z.enum(["ko", "en"]),
  kinds: z.array(PushKindSchema).min(1),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

/** POST /push/send?v=1: one event for the account's phones, or the phones in `to`. */
export const PushSendSchema = z.object({
  id: z.string().regex(PUSH_EVENT_ID_PATTERN),
  kind: PushKindSchema,
  /** Seconds from when the server takes the request, before it clamps to the kind's range. */
  ttl: z.number().int().positive(),
  to: z.array(DeviceIdSchema).min(1).max(20).optional(),
});
export type PushSend = z.infer<typeof PushSendSchema>;

/** A send's counts, or that the server has already seen this event. */
export const PushSendResultSchema = z.union([
  z.object({
    sent: z.number(),
    skipped: z.number(),
    /** How many phones were skipped for each reason: rate_limited, no_registration, kind_off, no_session. */
    reasons: z.record(z.string(), z.number()).optional(),
  }),
  z.object({ duplicate: z.literal(true) }),
]);
export type PushSendResult = z.infer<typeof PushSendResultSchema>;

/** The `nx` data a phone gets with a notification. The server makes the APNs `aps` part. */
export const PushPayloadSchema = z.object({
  v: z.literal(PUSH_VERSION),
  k: PushKindSchema,
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
