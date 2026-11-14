/**
 * A note's recordings and what was said in them: `transcript.json` in the
 * note's folder (with `transcript.md`, the same as text for agents), the
 * audio itself in its `recordings/`.
 *
 * A recording runs from "Record" to "Stop". It is made of takes, one per
 * voice session on the server: a pause ends a take and going on starts the
 * next, and a recording longer than a session allows goes on in a new one.
 * Each take is a file of its own, and a server labels the voices it hears
 * anew in each session, so a voice's key carries its take ("1" in the first
 * take, "2.1" in the second); the names the user gives are by key, and
 * giving two keys one name makes them one person.
 *
 * Pure: no IO here.
 */
import { z } from "zod";

export const TRANSCRIPT_VERSION = 1;

/** A recording's id: r + base36 time + 4 hex. */
export const RECORDING_ID_RE = /^r[0-9a-z]{6,12}[0-9a-f]{4}$/;

/** A take's audio, by place in the note's folder. */
export const TAKE_FILE_RE = /^recordings\/r[0-9a-z]{6,12}[0-9a-f]{4}-\d{1,3}\.(webm|ogg)$/;

/** One stretch of one voice's words. Times are from the recording's start, in ms. */
export const TranscriptLineSchema = z.object({
  speaker: z.string().min(1).max(40),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

/** How far a take's second pass (the whole file heard again) is. */
export const TakePassSchema = z.enum(["none", "pending", "done", "error"]);
export type TakePass = z.infer<typeof TakePassSchema>;

export const TranscriptTakeSchema = z.object({
  /** recordings/<recording id>-<n>.webm */
  file: z.string().regex(TAKE_FILE_RE),
  /** Where the take starts in the recording. */
  offsetMs: z.number().nonnegative(),
  /** Its length, as the server counted it once it was done. */
  seconds: z.number().nonnegative(),
  /** The session's `done.transcribeToken`, until it is used. */
  token: z.string().optional(),
  /** The second pass on the server, while it is under way. */
  transcriptionId: z.string().optional(),
  pass: TakePassSchema,
});
export type TranscriptTake = z.infer<typeof TranscriptTakeSchema>;

export const TranscriptRecordingSchema = z.object({
  id: z.string().regex(RECORDING_ID_RE),
  /** Epoch ms. */
  startedAt: z.number(),
  /** The language listened for. */
  language: z.string(),
  takes: z.array(TranscriptTakeSchema),
  /** Names given to voices, by key. */
  speakers: z.record(z.string(), z.string()),
  lines: z.array(TranscriptLineSchema),
  /** The audio was deleted (the text stays). */
  audioRemoved: z.boolean().optional(),
});
export type TranscriptRecording = z.infer<typeof TranscriptRecordingSchema>;

export const TranscriptFileSchema = z.object({
  version: z.literal(TRANSCRIPT_VERSION),
  recordings: z.array(TranscriptRecordingSchema),
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export const EMPTY_TRANSCRIPT: TranscriptFile = { version: TRANSCRIPT_VERSION, recordings: [] };

/** The key of voice `label` in take `take` (0-based). */
export function speakerKey(take: number, label: string): string {
  return take === 0 ? label : `${take + 1}.${label}`;
}

/** Where a take's audio goes. */
export function takeFile(recordingId: string, take: number): string {
  return `recordings/${recordingId}-${take + 1}.webm`;
}

/** The voices of a recording, in the order they first spoke. */
export function speakersOf(recording: Pick<TranscriptRecording, "lines">): string[] {
  const seen: string[] = [];
  for (const line of recording.lines) if (!seen.includes(line.speaker)) seen.push(line.speaker);
  return seen;
}

/** How many people spoke: voices given one name count once. */
export function peopleIn(recording: Pick<TranscriptRecording, "lines" | "speakers">): number {
  return new Set(speakersOf(recording).map((k) => recording.speakers[k]?.trim() || `#${k}`)).size;
}

/** A recording's length: its takes', or as far as its words go while a take is open. */
export function recordingMs(recording: Pick<TranscriptRecording, "takes" | "lines">): number {
  const takes = recording.takes.reduce((ms, t) => Math.max(ms, t.offsetMs + t.seconds * 1000), 0);
  const words = recording.lines.reduce((ms, l) => Math.max(ms, l.endMs), 0);
  return Math.max(takes, words);
}

/**
 * The names for a second pass's voices: each takes the name of the voice
 * (as the live session had them) it shares the most time with, if that one
 * had a name. Two new voices may take one name; that is one person heard
 * as two.
 */
export function carryNames(
  live: readonly TranscriptLine[],
  names: Readonly<Record<string, string>>,
  next: readonly TranscriptLine[],
): Record<string, string> {
  const overlap = new Map<string, Map<string, number>>();
  for (const n of next) {
    for (const l of live) {
      const shared = Math.min(n.endMs, l.endMs) - Math.max(n.startMs, l.startMs);
      if (shared <= 0) continue;
      const byLive = overlap.get(n.speaker) ?? new Map<string, number>();
      byLive.set(l.speaker, (byLive.get(l.speaker) ?? 0) + shared);
      overlap.set(n.speaker, byLive);
    }
  }
  const out: Record<string, string> = {};
  for (const [speaker, byLive] of overlap) {
    let best = "";
    let most = 0;
    for (const [liveSpeaker, ms] of byLive) {
      if (ms > most) {
        most = ms;
        best = liveSpeaker;
      }
    }
    const name = names[best]?.trim();
    if (name) out[speaker] = name;
  }
  return out;
}

/**
 * A take's lines replaced by its second pass: the take's own lines go, the
 * pass's come in (moved to the take's place in the recording, their voices
 * keyed by the take), and names carry over by time.
 */
export function withSecondPass(
  recording: TranscriptRecording,
  take: number,
  segments: readonly TranscriptLine[],
): TranscriptRecording {
  const t = recording.takes[take];
  if (!t) return recording;
  const inTake = (key: string) =>
    take === 0 ? !key.includes(".") : key.startsWith(`${take + 1}.`);
  const old = recording.lines.filter((l) => inTake(l.speaker));
  const rest = recording.lines.filter((l) => !inTake(l.speaker));
  const fresh = segments
    .filter((s) => s.text.trim())
    .map((s) => ({
      speaker: speakerKey(take, s.speaker),
      startMs: t.offsetMs + s.startMs,
      endMs: t.offsetMs + s.endMs,
      text: s.text.trim(),
    }));
  const oldNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(recording.speakers)) if (inTake(k)) oldNames[k] = v;
  const carried = carryNames(old, oldNames, fresh);
  const speakers: Record<string, string> = {};
  for (const [k, v] of Object.entries(recording.speakers)) if (!inTake(k)) speakers[k] = v;
  Object.assign(speakers, carried);
  return {
    ...recording,
    speakers,
    lines: [...rest, ...fresh].sort((a, b) => a.startMs - b.startMs),
  };
}

/** "3:07", or "1:03:07" past an hour. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A voice's name, or "Speaker 2" (its label, with its take: "Speaker 2.1"). */
export function speakerName(
  recording: Pick<TranscriptRecording, "speakers">,
  key: string,
  unnamed: (label: string) => string = (label) => `Speaker ${label}`,
): string {
  return recording.speakers[key]?.trim() || unnamed(key);
}

/** Adjacent lines of one voice, run together: how a transcript reads. */
export function joinedLines(lines: readonly TranscriptLine[], gapMs = 4000): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.speaker === line.speaker && line.startMs - last.endMs <= gapMs) {
      out[out.length - 1] = {
        ...last,
        endMs: Math.max(last.endMs, line.endMs),
        text: joinText(last.text, line.text),
      };
    } else out.push({ ...line });
  }
  return out;
}

/** Two stretches of words as one: with a space, except between CJK characters. */
function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const cjk = /[぀-ヿ㐀-鿿]$/.test(a) && /^[぀-ヿ㐀-鿿]/.test(b);
  return cjk ? a + b : `${a} ${b}`;
}

function dateOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `transcript.md`: each recording, then its words, a voice and a time to a line. */
export function transcriptMarkdown(file: TranscriptFile, title: string): string {
  const out: string[] = [`# Transcript${title.trim() ? `: ${title.trim()}` : ""}`];
  for (const rec of file.recordings) {
    out.push("", `## Recording ${dateOf(rec.startedAt)} (${clockOf(recordingMs(rec))})`, "");
    const lines = joinedLines(rec.lines);
    if (!lines.length) out.push("(nothing heard)");
    for (const line of lines) {
      out.push(`[${clockOf(line.startMs)}] ${speakerName(rec, line.speaker)}: ${line.text}`);
    }
  }
  return `${out.join("\n")}\n`;
}
