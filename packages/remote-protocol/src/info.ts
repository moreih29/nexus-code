/**
 * GET /info, signed in or not: what the server offers, so a device shows
 * only what works there.
 */
import { z } from "zod";

export const ServerInfoSchema = z.object({
  /**
   * The sign-ins the server has, each its own /auth/<name>/start. A device
   * offers one button for each it knows. "dev" is only for local servers.
   */
  signIn: z.array(z.string()),
  relay: z.object({ version: z.number().int() }).nullable(),
  /** Null where the server has no speech-to-text provider: no microphone then. */
  voice: z.object({ version: z.number().int() }).nullable(),
  /**
   * Account keys v2 (device keys, rotation, the password's proof, a reset
   * that waits): `{ version: 2 }` where the server has them. Absent or null
   * before; a device then keeps to v1. Pairing needs nothing of the server.
   */
  accountKeys: z.object({ version: z.number().int() }).nullable().optional(),
  /** The push API and its APNs environments. Null without push keys, absent from older servers. */
  push: z
    .object({
      version: z.number().int(),
      /** Known environments are `production` and `sandbox`. New ones may be added. */
      environments: z.array(z.string()),
    })
    .nullable()
    .optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
