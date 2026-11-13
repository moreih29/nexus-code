/**
 * GET /info, signed in or not: what the server offers, so a device shows
 * only what works there.
 */
import { z } from "zod";

export const ServerInfoSchema = z.object({
  /** The sign-ins the server has: "google"; "dev" only on a server at localhost. */
  signIn: z.array(z.string()),
  relay: z.object({ version: z.number().int() }).nullable(),
  /** Null where the server has no speech-to-text provider: no microphone then. */
  voice: z.object({ version: z.number().int() }).nullable(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
