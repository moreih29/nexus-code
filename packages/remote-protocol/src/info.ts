/**
 * GET /info, signed in or not: what the server offers, so a device shows
 * only what works there.
 */
import { z } from "zod";

export const ServerInfoSchema = z.object({
  /**
   * The sign-ins the server has, each its own /auth/<name>/start: "google",
   * "github", and "dev" only on a server at localhost. A device offers one
   * button for each it knows.
   */
  signIn: z.array(z.string()),
  relay: z.object({ version: z.number().int() }).nullable(),
  /** Null where the server has no speech-to-text provider: no microphone then. */
  voice: z.object({ version: z.number().int() }).nullable(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
