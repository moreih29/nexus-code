import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeNumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import {
  TranscriptionSchema,
  VoiceLanguageSchema,
  VoicePurposeSchema,
  VoiceServerMessageSchema,
  VoiceUsageSchema,
} from "../../../packages/remote-protocol/src/voice";

export const VOICE_FAILURES = [
  "signed-out",
  "unavailable",
  "quota",
  "busy",
  "rate-limited",
  "network",
  "in-use",
  "outdated",
  "response-too-large",
  "failed",
] as const;
export const VoiceFailureSchema = z.enum(VOICE_FAILURES);
export type VoiceFailure = z.infer<typeof VoiceFailureSchema>;

export const VOICE_CLOSE_SIGNED_OUT = 4001;

export const MAX_VOICE_TERMS = 300;
export const MAX_VOICE_TERM_CHARS = 80;
export const MAX_VOICE_NAMES = 60;

const VoiceTermSchema = z.string().max(MAX_VOICE_TERM_CHARS);

export const VoiceTermsSchema = z.object({ terms: z.array(z.string()) });

export const SetVoiceTermsArgsSchema = z.object({
  terms: z.array(VoiceTermSchema).max(MAX_VOICE_TERMS),
});

export function clipTerm(text: string, max = MAX_VOICE_TERM_CHARS): string {
  const clipped = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

export const VoiceStartArgsSchema = z.object({
  language: VoiceLanguageSchema,
  purpose: VoicePurposeSchema.optional(),
});

export const VoiceStartResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    id: z.string(),
    sampleRate: PositiveIntegerSchema,
    maxSeconds: NonnegativeNumberSchema,
  }),
  z.object({ status: z.literal("failed"), reason: VoiceFailureSchema, message: z.string() }),
]);
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>;

export const VoiceAudioArgsSchema = z.object({
  id: z.string(),
  audio: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "audio bytes"),
});

export const VoiceEventSchema = z.object({
  id: z.string(),
  event: z.union([
    VoiceServerMessageSchema,
    z.object({ t: z.literal("closed"), code: IntegerSchema }),
  ]),
});
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;

export const VoiceTranscribeArgsSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  file: z.string().min(1).max(200),
  token: z.string().min(1).max(4096),
  language: VoiceLanguageSchema,
});

export const TranscribeFailureSchema = z.enum([
  "signed-out",
  "expired",
  "too-big",
  "quota",
  "busy",
  "missing",
  "network",
  "failed",
]);

export type TranscribeFailure = z.infer<typeof TranscribeFailureSchema>;

export const TranscribeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("submitted"), id: z.string() }),
  z.object({ status: z.literal("failed"), reason: TranscribeFailureSchema, message: z.string() }),
]);
export type TranscribeResult = z.infer<typeof TranscribeResultSchema>;

export { TranscriptionSchema, VoiceUsageSchema };
