import { z } from "zod";
import { IntegerSchema, NonnegativeIntegerSchema, PositiveIntegerSchema } from "./validation.js";

export const RELAY_VERSION = 2;

export const UNSUPPORTED_VERSION = "unsupported_version";
export const UnsupportedVersionSchema = z.object({
  error: z.literal(UNSUPPORTED_VERSION),
  version: IntegerSchema,
});

export const DeviceIdSchema = z.string().min(1).max(64);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const ALL_DEVICES = "*";

export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/);

export const OutgoingSchema = z.object({
  t: z.literal("send"),
  to: z.union([DeviceIdSchema, z.literal(ALL_DEVICES)]),
  seq: PositiveIntegerSchema,
  kid: NonnegativeIntegerSchema,
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type Outgoing = z.infer<typeof OutgoingSchema>;

export const DeliveredSchema = OutgoingSchema.omit({ t: true }).extend({
  t: z.literal("message"),
  from: DeviceIdSchema,
});
export type Delivered = z.infer<typeof DeliveredSchema>;

export const RoomDeviceSchema = z.object({
  id: DeviceIdSchema,
  name: z.string(),
  alias: z.string().max(64).nullable().optional(),
  platform: z.string(),
  online: z.boolean(),
});
export type RoomDevice = z.infer<typeof RoomDeviceSchema>;

export const PresenceSchema = z.object({
  t: z.literal("presence"),
  self: DeviceIdSchema,
  devices: z.array(RoomDeviceSchema),
});
export type Presence = z.infer<typeof PresenceSchema>;

export const RelayErrorSchema = z.object({
  t: z.literal("error"),
  code: z.enum(["bad-frame", "too-big", "no-such-device", "unauthorized", "rate-limited"]),
  message: z.string(),
  seq: PositiveIntegerSchema.optional(),
});
export type RelayError = z.infer<typeof RelayErrorSchema>;

export const AccountEventSchema = z.object({
  t: z.literal("account"),
  event: z.enum(["key-rotated", "key-reset", "reset-pending", "reset-cancelled"]),
  kid: PositiveIntegerSchema.optional(),
  appliesAt: IntegerSchema.optional(),
});
export type AccountEvent = z.infer<typeof AccountEventSchema>;

export const ClientFrameSchema = OutgoingSchema;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion("t", [
  DeliveredSchema,
  PresenceSchema,
  RelayErrorSchema,
  AccountEventSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const MAX_FRAME_BYTES = 1024 * 1024;
