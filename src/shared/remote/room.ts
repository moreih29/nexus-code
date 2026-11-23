import { z } from "zod";
import { NonnegativeIntegerSchema } from "../../../packages/remote-protocol/src/validation";

export const RoomStatusSchema = z.enum([
  "off",
  "connecting",
  "online",
  "waiting",
  "replaced",
  "outdated",
  "stopped",
]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomPeerSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostName: z.string().optional(),
  platform: z.string(),
  online: z.boolean(),
  app: z.object({ name: z.string(), version: z.string() }).optional(),
  serves: z.array(z.string()).optional(),
  schema: z.string().optional(),
  rejoins: NonnegativeIntegerSchema.optional(),
});
export type RoomPeer = z.infer<typeof RoomPeerSchema>;

export const RoomStateSchema = z.object({
  status: RoomStatusSchema,
  peers: z.array(RoomPeerSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

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
