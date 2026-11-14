/**
 * Voice input between the renderer and main: main holds the voice socket
 * to the server (its upgrade's refusals, a 403 or a 429, are readable
 * there and not in a page), the renderer captures the microphone and
 * shows the text as it comes.
 */
import { z } from "zod";
import {
  TranscriptionSchema,
  VoiceLanguageSchema,
  VoicePurposeSchema,
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

export const VoiceStartArgsSchema = z.object({
  language: VoiceLanguageSchema,
  /** A note's recording rather than a dictation (its own session, beside a dictation's). */
  purpose: VoicePurposeSchema.optional(),
});

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

/** Sends a note's recording, one take's file, for a second pass. */
export const VoiceTranscribeArgsSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  /** The take's file, by place in the note's folder. */
  file: z.string().min(1).max(200),
  token: z.string().min(1).max(4096),
  language: VoiceLanguageSchema,
});

/** Why a second pass was not taken. */
export const TranscribeFailureSchema = z.enum([
  "signed-out",
  /** The token was used, or is older than a day (403). */
  "expired",
  /** The file is over MAX_TRANSCRIBE_BYTES (413). */
  "too-big",
  /** The take's file is not in the note. */
  "missing",
  "network",
  "failed",
]);

export const TranscribeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("submitted"), id: z.string() }),
  z.object({ status: z.literal("failed"), reason: TranscribeFailureSchema, message: z.string() }),
]);
export type TranscribeResult = z.infer<typeof TranscribeResultSchema>;

export { TranscriptionSchema, VoiceUsageSchema };
