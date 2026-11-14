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
 *   append; it clears the partial). Every partial and final after the
 *   session's first final starts with the space its language puts between
 *   segments (none for ja or zh): the text is the finals joined as they
 *   came, then the partial, with nothing trimmed or added between;
 * - server: `limit` if the audio ran past what the session or the
 *   account's quota allows (audio past it is dropped; finals still come);
 * - server: `done` with the seconds counted, once every final is out; then
 *   it closes (1000). An `error` ends the session; it closes after.
 *
 * `&purpose=note` asks for a note's recording instead of a dictation:
 * - its seconds count against the month's note quota, apart from
 *   dictation's, and the server may let it run longer (`ready.maxSeconds`
 *   says how long); a device that records longer opens another session;
 * - it tells voices apart: each partial and final carries `speaker`, the
 *   provider's label for a voice ("1", "2", ...), the same for that voice
 *   for the rest of the session. A final holds one speaker's words, so a
 *   change of speaker ends a segment;
 * - each final carries `startMs` and `endMs`, where its words start and end
 *   in the session's audio, from its first frame;
 * - `done` carries `transcribeToken`: it lets the device send the session's
 *   recording once to POST /voice/transcriptions for a second pass over the
 *   whole file (a more accurate text and speakers), not counted again.
 *
 * The second pass (`purpose=note` sessions only), signed in as /voice is:
 * - POST /voice/transcriptions?v=1&lang=<language>, header
 *   `X-Transcribe-Token`, body the recording (audio/webm or audio/ogg with
 *   Opus, or audio/wav), at most MAX_TRANSCRIBE_BYTES: 202 with
 *   `{ id }`; 403 if the token is unknown, used or expired, 413 if the body
 *   is too big;
 * - GET /voice/transcriptions/<id>: a Transcription, `pending` until it is
 *   `done` (with its segments) or `error`; ask again every few seconds;
 * - DELETE /voice/transcriptions/<id>: 204; the server and its provider
 *   drop the recording and the text. The server drops them a day after
 *   anyway.
 */
import { z } from "zod";

export const VOICE_VERSION = 1;

/** Most bytes in one audio frame (2 s of 16 kHz 16-bit mono); an even count. */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

/** The language to hear, BCP 47-ish: "ko", "en", "en-US", or "multi" to detect it. */
export const VoiceLanguageSchema = z.string().regex(/^([a-z]{2,3}(-[A-Z]{2})?|multi)$/);

/** What a voice session is for: a dictation into a text box, or a note's recording. */
export const VoicePurposeSchema = z.enum(["dictation", "note"]);
export type VoicePurpose = z.infer<typeof VoicePurposeSchema>;

/** How long a `done`'s transcribeToken stays good for. */
export const TRANSCRIBE_TOKEN_MS = 24 * 60 * 60 * 1000;

/** Most bytes of a recording POST /voice/transcriptions takes (about 8 hours of 24 kbps Opus). */
export const MAX_TRANSCRIBE_BYTES = 90 * 1024 * 1024;

/** What a device sends besides audio: that the user stopped speaking. */
export const VoiceClientMessageSchema = z.object({ t: z.literal("end") });
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;

/** The provider's label for a voice in one session or transcription: "1", "2", ... */
export const SpeakerSchema = z.string().min(1).max(32);

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
  z.object({
    t: z.literal("partial"),
    text: z.string(),
    /** A note's session: whose words they are. */
    speaker: SpeakerSchema.optional(),
  }),
  z.object({
    t: z.literal("final"),
    text: z.string(),
    /** A note's session: whose words they are. */
    speaker: SpeakerSchema.optional(),
    /** A note's session: where the words start in the session's audio, in ms. */
    startMs: z.number().nonnegative().optional(),
    /** A note's session: where the words end in the session's audio, in ms. */
    endMs: z.number().nonnegative().optional(),
  }),
  z.object({ t: z.literal("limit"), reason: z.enum(["session", "quota"]) }),
  z.object({
    t: z.literal("done"),
    seconds: z.number().nonnegative(),
    /** A note's session: lets its recording go once to POST /voice/transcriptions. */
    transcribeToken: z.string().min(1).optional(),
  }),
  z.object({
    t: z.literal("error"),
    /** unauthorized: the device's sign-in ended (the socket closes 4001 after it). */
    code: z.enum(["bad-frame", "provider-error", "unauthorized"]),
    message: z.string(),
  }),
]);
export type VoiceServerMessage = z.infer<typeof VoiceServerMessageSchema>;

/** GET /voice/usage: this month's seconds, used and allowed. */
export const VoiceUsageSchema = z.object({
  /** The month, as YYYY-MM. */
  period: z.string(),
  /** Dictation's. */
  usedSeconds: z.number().nonnegative(),
  limitSeconds: z.number().nonnegative(),
  /** Notes' recordings', counted apart; missing from a server without them. */
  note: z
    .object({ usedSeconds: z.number().nonnegative(), limitSeconds: z.number().nonnegative() })
    .optional(),
});
export type VoiceUsage = z.infer<typeof VoiceUsageSchema>;

/** One speaker's stretch of a recording, as the second pass heard it. */
export const TranscriptSegmentSchema = z.object({
  speaker: SpeakerSchema,
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/** GET /voice/transcriptions/<id>: a second pass, waiting, done or failed. */
export const TranscriptionSchema = z.discriminatedUnion("status", [
  z.object({ id: z.string(), status: z.literal("pending") }),
  z.object({
    id: z.string(),
    status: z.literal("done"),
    /** In order of their start; speakers labelled anew, not as the live session had them. */
    segments: z.array(TranscriptSegmentSchema),
    /** The recording's length. */
    seconds: z.number().nonnegative(),
  }),
  z.object({ id: z.string(), status: z.literal("error"), message: z.string() }),
]);
export type Transcription = z.infer<typeof TranscriptionSchema>;
