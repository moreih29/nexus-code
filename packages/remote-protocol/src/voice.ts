import { z } from "zod";
import { NonnegativeNumberSchema, PositiveIntegerSchema } from "./validation.js";

export const VOICE_VERSION = 1;

export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

export const VoiceLanguageSchema = z.string().regex(/^([a-z]{2,3}(-[A-Z]{2})?|multi)$/);

export const VoicePurposeSchema = z.enum(["dictation", "note"]);
export type VoicePurpose = z.infer<typeof VoicePurposeSchema>;

export const TRANSCRIBE_TOKEN_MS = 24 * 60 * 60 * 1000;

export const MAX_TRANSCRIBE_BYTES = 90 * 1024 * 1024;

export const VoiceClientMessageSchema = z.object({ t: z.literal("end") });
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;

export const SpeakerSchema = z.string().min(1).max(32);

export const VoiceReadySchema = z.object({
  t: z.literal("ready"),
  format: z.literal("pcm_s16le"),
  sampleRate: PositiveIntegerSchema,
  maxSeconds: NonnegativeNumberSchema,
});

export const VoiceServerMessageSchema = z.discriminatedUnion("t", [
  VoiceReadySchema,
  z.object({
    t: z.literal("partial"),
    text: z.string(),
    speaker: SpeakerSchema.optional(),
  }),
  z.object({
    t: z.literal("final"),
    text: z.string(),
    speaker: SpeakerSchema.optional(),
    startMs: NonnegativeNumberSchema.optional(),
    endMs: NonnegativeNumberSchema.optional(),
  }),
  z.object({ t: z.literal("limit"), reason: z.enum(["session", "quota"]) }),
  z.object({
    t: z.literal("done"),
    seconds: NonnegativeNumberSchema,
    transcribeToken: z.string().min(1).optional(),
  }),
  z.object({
    t: z.literal("error"),
    code: z.enum(["bad-frame", "provider-error", "unauthorized"]),
    message: z.string(),
    transcribeToken: z.string().min(1).optional(),
  }),
]);
export type VoiceServerMessage = z.infer<typeof VoiceServerMessageSchema>;

export const VoiceUsageSchema = z.object({
  period: z.string(),
  usedSeconds: NonnegativeNumberSchema,
  limitSeconds: NonnegativeNumberSchema,
  note: z
    .object({ usedSeconds: NonnegativeNumberSchema, limitSeconds: NonnegativeNumberSchema })
    .optional(),
});
export type VoiceUsage = z.infer<typeof VoiceUsageSchema>;

export const TranscriptSegmentSchema = z.object({
  speaker: SpeakerSchema,
  startMs: NonnegativeNumberSchema,
  endMs: NonnegativeNumberSchema,
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptionSchema = z.discriminatedUnion("status", [
  z.object({ id: z.string(), status: z.literal("pending") }),
  z.object({
    id: z.string(),
    status: z.literal("done"),
    segments: z.array(TranscriptSegmentSchema),
    seconds: NonnegativeNumberSchema,
  }),
  z.object({ id: z.string(), status: z.literal("error"), message: z.string() }),
]);
export type Transcription = z.infer<typeof TranscriptionSchema>;
