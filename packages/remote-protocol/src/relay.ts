/**
 * What the relay sees: the frames between a device and its account's room.
 * A device sends sealed messages to another device of the account, or to
 * all of them; the relay checks who sent it, stamps it, and passes it on.
 * It cannot open what a message carries (see ./sealed.ts).
 */
import { z } from "zod";
import { IntegerSchema, NonnegativeIntegerSchema, PositiveIntegerSchema } from "./validation.js";

/**
 * The version of the frames below; the relay refuses a device that speaks
 * another. A device asks for its ticket with it (POST /relay/ticket?v=2) and
 * opens the socket with it (/relay?v=2&ticket=...). A version the server no
 * longer takes is turned down at the ticket, where a status can be read:
 * 400 with UnsupportedVersionSchema's body. That app must be updated; asking
 * again will not help. Version 2 is NexusCode 0.12.0's: its account keys v2
 * only, and the protocol package's 0.12.0 or later.
 */
export const RELAY_VERSION = 2;

/** The ticket's answer to a version it no longer takes (400): the one it wants. */
export const UNSUPPORTED_VERSION = "unsupported_version";
export const UnsupportedVersionSchema = z.object({
  error: z.literal(UNSUPPORTED_VERSION),
  version: IntegerSchema,
});

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
 * from 1: the other side takes them in its order, each once (see
 * ./sealed.ts). `kid` is the account key's version the message was sealed
 * with, or PAIR_KID (0) for a pairing frame, which goes to one device only
 * (see ./device-keys.ts): the relay refuses one to ALL_DEVICES.
 */
export const OutgoingSchema = z.object({
  t: z.literal("send"),
  to: z.union([DeviceIdSchema, z.literal(ALL_DEVICES)]),
  seq: PositiveIntegerSchema,
  kid: NonnegativeIntegerSchema,
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
  /** The name the device signed in with (its host's, say). */
  name: z.string(),
  /**
   * The name the user gave it, shown in its place (alias ?? name), with
   * `name` beside it where devices are looked at closely; null or absent
   * for none. A server before 0.11.0 sends none. Since 0.11.0.
   */
  alias: z.string().max(64).nullable().optional(),
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
  seq: PositiveIntegerSchema.optional(),
});
export type RelayError = z.infer<typeof RelayErrorSchema>;

/**
 * Something that befell the account, which the server tells every device
 * in the room (account keys v2):
 * - key-rotated: a rotation put the account key of version `kid` in place;
 *   a device fetches its envelope (GET /devices/current/key-envelopes);
 * - key-reset: a reset that waited is in place (version `kid`);
 * - reset-pending: a reset was asked for without the password, and is put
 *   in place at `appliesAt` unless called off;
 * - reset-cancelled: it was called off.
 * A device before v2 does not know the frame and drops it.
 */
export const AccountEventSchema = z.object({
  t: z.literal("account"),
  event: z.enum(["key-rotated", "key-reset", "reset-pending", "reset-cancelled"]),
  kid: PositiveIntegerSchema.optional(),
  appliesAt: IntegerSchema.optional(),
});
export type AccountEvent = z.infer<typeof AccountEventSchema>;

/** What a device sends the relay. */
export const ClientFrameSchema = OutgoingSchema;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/** What the relay sends a device. */
export const ServerFrameSchema = z.discriminatedUnion("t", [
  DeliveredSchema,
  PresenceSchema,
  RelayErrorSchema,
  AccountEventSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * Most bytes one frame may take as JSON. A chat's whole transcript goes in
 * pages under it (see ./rpc.ts).
 */
export const MAX_FRAME_BYTES = 1024 * 1024;
