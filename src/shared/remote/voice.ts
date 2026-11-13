/**
 * Voice input between the renderer and main: main holds the voice socket
 * to the server (its upgrade's refusals, a 403 or a 429, are readable
 * there and not in a page), the renderer captures the microphone and
 * shows the text as it comes.
 */
import { z } from "zod";
import {
  VoiceLanguageSchema,
  VoiceServerMessageSchema,
  VoiceUsageSchema,
} from "../../../packages/remote-protocol/src/voice";

/** Why a voice session did not start. */
export const VOICE_FAILURES = [
  /** Not signed in to NexusCode, or the sign-in ended. */
  "signed-out",
  /** The server has no voice input (its /info says none, or it answered 503). */
  "unavailable",
  /** This month's voice minutes are used up (403 quota_exceeded). */
  "quota",
  /** The account has as many voice sessions open as it may (429 too_many_sessions). */
  "busy",
  /** The server could not be reached, or the socket failed before it was ready. */
  "network",
  /** Another voice session of this app is still open. */
  "in-use",
  /** Anything else the server answered. */
  "failed",
] as const;
export const VoiceFailureSchema = z.enum(VOICE_FAILURES);
export type VoiceFailure = z.infer<typeof VoiceFailureSchema>;

export const VoiceStartArgsSchema = z.object({ language: VoiceLanguageSchema });

export const VoiceStartResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    id: z.string(),
    /** The rate to capture at: the server's `ready` names it. */
    sampleRate: z.number().int().positive(),
    maxSeconds: z.number().nonnegative(),
  }),
  z.object({ status: z.literal("failed"), reason: VoiceFailureSchema, message: z.string() }),
]);
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>;

/** Audio for an open session: PCM 16-bit little-endian, mono, at its sample rate. */
export const VoiceAudioArgsSchema = z.object({
  id: z.string(),
  audio: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "audio bytes"),
});

/**
 * What a session's socket said, as main passes it on: the server's own
 * messages after `ready`, then `closed` once the socket is shut, with its
 * close code (1000 when the server finished, 4001 when the sign-in ended,
 * 1006 when the connection dropped).
 */
export const VoiceEventSchema = z.object({
  id: z.string(),
  event: z.union([
    VoiceServerMessageSchema,
    z.object({ t: z.literal("closed"), code: z.number().int() }),
  ]),
});
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;

export { VoiceUsageSchema };
