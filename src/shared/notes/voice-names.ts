import { z } from "zod";
import { RECORDING_ID_RE, type TranscriptRecording } from "./transcript";
import type { VoiceSample } from "./voices";

export const VOICE_NAME_LINE_MS = 3000;
export const VOICE_NAME_SPEECH_MS = 9000;
export const VOICE_NAME_SIMILARITY = 0.72;
export const VOICE_NAME_MARGIN = 0.05;
export const VOICE_LEARNING_SIMILARITY = 0.72;
export const VOICE_NAME_RECORDINGS = 5;
export const VOICE_NAME_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const VoiceNameSchema = z.string().trim().min(1).max(80);
const VectorSchema = z.array(z.number().finite()).length(192);
export const VoiceNameSettingsSchema = z.object({
  consent: z.enum(["pending", "allowed", "declined"]).default("pending"),
  suggest: z.boolean().default(true),
  expire: z.boolean().default(true),
});
export type VoiceNameSettings = z.infer<typeof VoiceNameSettingsSchema>;
export const VoiceNamePreferencesSchema = VoiceNameSettingsSchema.pick({
  suggest: true,
  expire: true,
}).partial();
export const VoiceNameStatusSchema = VoiceNameSettingsSchema.extend({
  available: z.boolean(),
  revision: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type VoiceNameStatus = z.infer<typeof VoiceNameStatusSchema>;

export const VoiceNamePersonSchema = z.object({
  name: VoiceNameSchema,
  count: z.number().int().positive(),
  lastHeard: z.number().finite(),
});
export type VoiceNamePerson = z.infer<typeof VoiceNamePersonSchema>;

const CandidateSchema = z.object({
  key: z.string().min(1).max(40),
  vector: VectorSchema,
  rejected: z.array(VoiceNameSchema),
});
export type VoiceNameCandidate = z.infer<typeof CandidateSchema>;

export const VoiceNameMatchArgsSchema = z.object({
  revision: z.number().int().nonnegative(),
  named: z.array(VoiceNameSchema),
  speakers: z.array(CandidateSchema),
});
export const VoiceNameSuggestionSchema = CandidateSchema.pick({ key: true }).extend({
  name: VoiceNameSchema,
});
export type VoiceNameSuggestion = z.infer<typeof VoiceNameSuggestionSchema>;

export const VoiceNameLearnArgsSchema = z.object({
  revision: VoiceNameMatchArgsSchema.shape.revision,
  name: VoiceNameSchema,
  recordingId: z.string().regex(RECORDING_ID_RE),
  recordedAt: z.number().finite().nonnegative(),
  vector: VectorSchema,
});

export const RememberedVoiceSchema = z.object({
  name: VoiceNameSchema,
  average: VectorSchema,
  recordings: z
    .array(VoiceNameLearnArgsSchema.pick({ recordingId: true, recordedAt: true, vector: true }))
    .min(1)
    .max(VOICE_NAME_RECORDINGS),
});
export type RememberedVoice = z.infer<typeof RememberedVoiceSchema>;

export function voiceSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -1;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += (a[i] as number) * (b[i] as number);
  return score;
}

export function averageVoice(vectors: readonly ArrayLike<number>[]): number[] | null {
  const length = vectors[0]?.length ?? 0;
  const total = new Float64Array(length);
  for (const vector of vectors) {
    if (vector.length !== length) return null;
    for (let i = 0; i < length; i++) total[i] = (total[i] as number) + (vector[i] as number);
  }
  const norm = Math.sqrt(voiceSimilarity(total, total));
  return Number.isFinite(norm) && norm > 0 ? Array.from(total, (v) => v / norm) : null;
}

/** Match prints to the current transcript's assignments, including manual edits. */
export function speakerPrints(
  recording: Pick<TranscriptRecording, "lines">,
  samples: readonly VoiceSample[],
  keys?: ReadonlySet<string>,
): Map<string, number[]> {
  const byStart = new Map(samples.map((s) => [s.at, s]));
  const grouped = new Map<string, { ms: number; vectors: ArrayLike<number>[] }>();
  for (const line of recording.lines) {
    if (keys && !keys.has(line.speaker)) continue;
    const sample = byStart.get(line.startMs);
    const ms = line.endMs - line.startMs;
    if (!sample || sample.ms !== ms || ms < VOICE_NAME_LINE_MS) continue;
    const group = grouped.get(line.speaker) ?? { ms: 0, vectors: [] };
    group.ms += ms;
    group.vectors.push(sample.vector);
    grouped.set(line.speaker, group);
  }
  const prints = new Map<string, number[]>();
  for (const [key, group] of grouped) {
    if (group.ms < VOICE_NAME_SPEECH_MS) continue;
    const vector = averageVoice(group.vectors);
    if (vector) prints.set(key, vector);
  }
  return prints;
}

export function voiceNameCandidates(
  recording: TranscriptRecording,
  samples: readonly VoiceSample[],
): Pick<z.infer<typeof VoiceNameMatchArgsSchema>, "named" | "speakers"> {
  const named = new Set<string>();
  const unnamed = new Set<string>();
  for (const { speaker } of recording.lines) {
    const name = Object.hasOwn(recording.speakers, speaker)
      ? recording.speakers[speaker]?.trim()
      : "";
    if (name) named.add(name);
    else unnamed.add(speaker);
  }
  const speakers = Array.from(speakerPrints(recording, samples, unnamed), ([key, vector]) => ({
    key,
    vector,
    rejected: Object.hasOwn(recording.rejectedVoiceNames ?? {}, key)
      ? (recording.rejectedVoiceNames?.[key] ?? [])
      : [],
  }));
  return { named: [...named], speakers };
}

/** Only the strongest unambiguous match for each name may be shown in a recording. */
export function suggestVoiceNames(
  profiles: readonly Pick<RememberedVoice, "name" | "average">[],
  candidates: ReturnType<typeof voiceNameCandidates>,
): VoiceNameSuggestion[] {
  const named = new Set(candidates.named);
  const winners = new Map<string, { score: number; key: string }>();
  for (const speaker of candidates.speakers) {
    let best: { name: string; score: number } | undefined;
    let second = -1;
    for (const profile of profiles) {
      const score = voiceSimilarity(profile.average, speaker.vector);
      if (!best || score > best.score) {
        second = best?.score ?? -1;
        best = { name: profile.name, score };
      } else {
        second = Math.max(second, score);
      }
    }
    if (!best || best.score < VOICE_NAME_SIMILARITY || best.score - second < VOICE_NAME_MARGIN)
      continue;
    if (named.has(best.name) || speaker.rejected.includes(best.name)) continue;
    if ((winners.get(best.name)?.score ?? -1) < best.score) {
      winners.set(best.name, { key: speaker.key, score: best.score });
    }
  }
  return Array.from(winners, ([name, { key }]) => ({ key, name }));
}

export function withRememberedVoice(
  previous: RememberedVoice | undefined,
  {
    name,
    recordingId,
    recordedAt,
    vector,
  }: Omit<z.infer<typeof VoiceNameLearnArgsSchema>, "revision">,
): RememberedVoice | undefined {
  const print = averageVoice([vector]);
  if (
    !print ||
    (previous && voiceSimilarity(previous.average, print) < VOICE_LEARNING_SIMILARITY)
  ) {
    return undefined;
  }
  const recordings = [
    ...(previous?.recordings.filter((r) => r.recordingId !== recordingId) ?? []),
    { recordingId, recordedAt, vector: print },
  ]
    .sort((a, b) => b.recordedAt - a.recordedAt || b.recordingId.localeCompare(a.recordingId))
    .slice(0, VOICE_NAME_RECORDINGS);
  const average = averageVoice(recordings.map((r) => r.vector));
  return average ? { name, recordings, average } : undefined;
}
