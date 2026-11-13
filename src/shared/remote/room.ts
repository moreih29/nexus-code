/**
 * The account's room on the relay, as this device sees it: whether it is
 * in, and the account's other devices, online or not, with what each said
 * in its hello.
 */
import { z } from "zod";

export const RoomStatusSchema = z.enum([
  /** Not in the room: signed out, or without the account key. */
  "off",
  "connecting",
  "online",
  /** Lost the relay, trying again after a while. */
  "waiting",
  /** This device connected again elsewhere (another instance): this one stays out. */
  "replaced",
  "stopped",
]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomPeerSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  online: z.boolean(),
  /** From its hello, once it said one: its app, and what it serves of its sessions. */
  app: z.object({ name: z.string(), version: z.string() }).optional(),
  serves: z.array(z.string()).optional(),
  /** The protocol package's version it speaks (0.2.0 on); absent from an older one. */
  schema: z.string().optional(),
});
export type RoomPeer = z.infer<typeof RoomPeerSchema>;

export const RoomStateSchema = z.object({
  status: RoomStatusSchema,
  /** The account's other devices. */
  peers: z.array(RoomPeerSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;
