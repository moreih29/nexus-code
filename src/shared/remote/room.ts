/**
 * The account's room on the relay, as this device sees it: whether it is
 * in, and the account's other devices, online or not, with what each said
 * in its hello.
 */
import { z } from "zod";
import { NonnegativeIntegerSchema } from "../../../packages/remote-protocol/src/validation";

export const RoomStatusSchema = z.enum([
  /** Not in the room: signed out, or without the account key. */
  "off",
  "connecting",
  "online",
  /** Lost the relay, trying again after a while. */
  "waiting",
  /** This device connected again elsewhere (another instance): this one stays out. */
  "replaced",
  /** The server no longer takes this app's version: out until it is updated. */
  "outdated",
  "stopped",
]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomPeerSchema = z.object({
  id: z.string(),
  /** As the user knows it: the alias they gave it, or the name it signed in with. */
  name: z.string(),
  /** The name it signed in with (its host's), when an alias is shown in its place. */
  hostName: z.string().optional(),
  platform: z.string(),
  online: z.boolean(),
  /** From its hello, once it said one: its app, and what it serves of its sessions. */
  app: z.object({ name: z.string(), version: z.string() }).optional(),
  serves: z.array(z.string()).optional(),
  /** The protocol package's version it speaks (0.2.0 on); absent from an older one. */
  schema: z.string().optional(),
  /**
   * How many times it joined the room again with a new connection while
   * this device stayed, which the room may not have shown: what was watched
   * there was dropped, and is watched again as this grows. Absent before.
   */
  rejoins: NonnegativeIntegerSchema.optional(),
});
export type RoomPeer = z.infer<typeof RoomPeerSchema>;

export const RoomStateSchema = z.object({
  status: RoomStatusSchema,
  /** The account's other devices. */
  peers: z.array(RoomPeerSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

/**
 * Whether a device that speaks protocol `schema` (its hello's) has what
 * `version` brought; one that told none speaks an older one.
 */
export function speaks(schema: string | undefined, version: string): boolean {
  if (!schema) return false;
  const have = schema.split(".").map(Number);
  const want = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
