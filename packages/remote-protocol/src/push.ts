import { z } from "zod";
import { DeviceIdSchema } from "./relay.js";
import { NumberSchema, PositiveIntegerSchema, wireRecord } from "./validation.js";

export const PUSH_VERSION = 1;

export const PushKindSchema = z.enum(["consent", "request", "result"]);
export type PushKind = z.infer<typeof PushKindSchema>;

export const PUSH_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,43}$/;

export const PUSH_TTL_SECONDS = {
  consent: { min: 5, max: 120 },
  request: { min: 5, max: 900 },
  result: { min: 5, max: 1800 },
} as const;

export const PushRegistrationSchema = z.object({
  service: z.literal("apns"),
  token: z.string().regex(/^[a-f0-9]{32,512}$/),
  environment: z.enum(["production", "sandbox"]),
  locale: z.enum(["ko", "en"]),
  kinds: z.array(PushKindSchema).min(1),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

export const PushSendSchema = z.object({
  id: z.string().regex(PUSH_EVENT_ID_PATTERN),
  kind: PushKindSchema,
  ttl: PositiveIntegerSchema,
  to: z.array(DeviceIdSchema).min(1).max(20).optional(),
});
export type PushSend = z.infer<typeof PushSendSchema>;

export const PushSendResultSchema = z.union([
  z.object({
    sent: NumberSchema,
    skipped: NumberSchema,
    reasons: wireRecord(z.string(), NumberSchema).optional(),
  }),
  z.object({ duplicate: z.literal(true) }),
]);
export type PushSendResult = z.infer<typeof PushSendResultSchema>;

export const PushPayloadSchema = z.object({
  v: z.literal(PUSH_VERSION),
  k: PushKindSchema,
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
