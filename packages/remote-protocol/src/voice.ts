/**
 * The voice socket: what a device says goes to the server as audio and
 * comes back as text while it speaks (streaming speech to text).
 *
 * GET /voice?v=1&lang=<language> upgrades to a WebSocket, signed in as
 * /relay is (a Bearer header, or ?ticket= from POST /relay/ticket). Then:
 * - server: `ready`, naming the audio format and sample rate to send, and
 *   the most seconds this session may take;
 * - client: binary frames of audio in that format, about 100 ms each, then
 *   `end` when the user stops;
 * - server, as they come: `partial` (the words so far of the segment being
 *   spoken; each replaces the last) and `final` (a finished segment, to
 *   append; it clears the partial);
 * - server: `limit` if the audio ran past what the session or the
 *   account's quota allows (audio past it is dropped; finals still come);
 * - server: `done` with the seconds counted, once every final is out; then
 *   it closes (1000). An `error` ends the session; it closes after.
 */
import { z } from "zod";

export const VOICE_VERSION = 1;

/** Most bytes in one audio frame (2 s of 16 kHz 16-bit mono); an even count. */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

/** The language to hear, BCP 47-ish: "ko", "en", "en-US", or "multi" to detect it. */
export const VoiceLanguageSchema = z.string().regex(/^([a-z]{2,3}(-[A-Z]{2})?|multi)$/);

/** What a device sends besides audio: that the user stopped speaking. */
export const VoiceClientMessageSchema = z.object({ t: z.literal("end") });
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;

export const VoiceReadySchema = z.object({
  t: z.literal("ready"),
  format: z.literal("pcm_s16le"),
  /** The rate to send at; it may change with the provider, so it is not to be assumed. */
  sampleRate: z.number().int().positive(),
  /** The fewer of the session's limit and what is left of the month's quota. */
  maxSeconds: z.number().nonnegative(),
});

export const VoiceServerMessageSchema = z.discriminatedUnion("t", [
  VoiceReadySchema,
  z.object({ t: z.literal("partial"), text: z.string() }),
  z.object({ t: z.literal("final"), text: z.string() }),
  z.object({ t: z.literal("limit"), reason: z.enum(["session", "quota"]) }),
  z.object({ t: z.literal("done"), seconds: z.number().nonnegative() }),
  z.object({
    t: z.literal("error"),
    code: z.enum(["bad-frame", "provider-error"]),
    message: z.string(),
  }),
]);
export type VoiceServerMessage = z.infer<typeof VoiceServerMessageSchema>;

/** GET /voice/usage: this month's seconds, used and allowed. */
export const VoiceUsageSchema = z.object({
  /** The month, as YYYY-MM. */
  period: z.string(),
  usedSeconds: z.number().nonnegative(),
  limitSeconds: z.number().nonnegative(),
});
export type VoiceUsage = z.infer<typeof VoiceUsageSchema>;
