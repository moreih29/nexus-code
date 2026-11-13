/**
 * What the relay sees: the frames between a device and its account's room.
 * A device sends sealed messages to another device of the account, or to
 * all of them; the relay checks who sent it, stamps it, and passes it on.
 * It cannot open what a message carries (see ./sealed.ts).
 */
import { z } from "zod";

/** The version of the frames below; the relay refuses a device that speaks another. */
export const RELAY_VERSION = 1;

/** A device's id, as the server gave it when the device signed in. */
export const DeviceIdSchema = z.string().min(1).max(64);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

/** Every other device of the account that is in the room. */
export const ALL_DEVICES = "*";

/** Unpadded base64url, as the sealed bytes travel. */
export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/);

/**
 * A sealed message, as the sender gives it to the relay. `to` is one device
 * or ALL_DEVICES. `seq` counts the sender's messages since it connected,
 * from 1, so the other side can tell one lost or repeated. `kid` is the
 * account key's version the message was sealed with.
 */
export const OutgoingSchema = z.object({
  t: z.literal("send"),
  to: z.union([DeviceIdSchema, z.literal(ALL_DEVICES)]),
  seq: z.number().int().positive(),
  kid: z.number().int().nonnegative(),
  nonce: Base64UrlSchema,
  box: Base64UrlSchema,
});
export type Outgoing = z.infer<typeof OutgoingSchema>;

/** A sealed message as the relay delivers it, with the sender it vouches for. */
export const DeliveredSchema = OutgoingSchema.omit({ t: true }).extend({
  t: z.literal("message"),
  from: DeviceIdSchema,
});
export type Delivered = z.infer<typeof DeliveredSchema>;

/** A device of the account, as the relay tells who is in the room. */
export const RoomDeviceSchema = z.object({
  id: DeviceIdSchema,
  name: z.string(),
  /** darwin, win32, linux, ios, android, web. */
  platform: z.string(),
  online: z.boolean(),
});
export type RoomDevice = z.infer<typeof RoomDeviceSchema>;

/**
 * Who is in the room: sent once a device joins, and again whenever a device
 * comes or goes. `self` is the device it is sent to.
 */
export const PresenceSchema = z.object({
  t: z.literal("presence"),
  self: DeviceIdSchema,
  devices: z.array(RoomDeviceSchema),
});
export type Presence = z.infer<typeof PresenceSchema>;

/**
 * The relay could not take a frame: it was malformed, too big, sent to a
 * device not in the room, or the device's sign-in ended (then the relay
 * closes the socket after it).
 */
export const RelayErrorSchema = z.object({
  t: z.literal("error"),
  code: z.enum(["bad-frame", "too-big", "no-such-device", "unauthorized", "rate-limited"]),
  message: z.string(),
  /** The seq of the frame it refuses, when it was a message. */
  seq: z.number().int().positive().optional(),
});
export type RelayError = z.infer<typeof RelayErrorSchema>;

/** What a device sends the relay. */
export const ClientFrameSchema = OutgoingSchema;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/** What the relay sends a device. */
export const ServerFrameSchema = z.discriminatedUnion("t", [
  DeliveredSchema,
  PresenceSchema,
  RelayErrorSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * Most bytes one frame may take as JSON. A chat's whole transcript goes in
 * pages under it (see ./rpc.ts).
 */
export const MAX_FRAME_BYTES = 1024 * 1024;
