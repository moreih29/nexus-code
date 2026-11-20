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
 * giving two keys one name makes them one person. A recording the app told
 * its voices apart in by voice print (voices.ts) keys them for the whole
 * recording instead ("1", "2", … across its takes).
 *
 * Pure: no IO here.
 */
import { z } from "zod";
import { nextVoiceKey, voicePerson } from "./voices";

export const TRANSCRIPT_VERSION = 1;

/** A recording's id: r + base36 time + 4 hex. */
export const RECORDING_ID_RE = /^r[0-9a-z]{6,12}[0-9a-f]{4}$/;

/** A take's audio, by place in the note's folder. */
export const TAKE_FILE_RE = /^recordings\/r[0-9a-z]{6,12}[0-9a-f]{4}-\d{1,3}\.(webm|ogg)$/;

export const ParticipantCountSchema = z.union([
  z.literal("auto"),
  z.literal("7+"),
  z.number().int().positive(),
]);
export type ParticipantCount = z.infer<typeof ParticipantCountSchema>;

export const PARTICIPANT_OPTIONS = ["auto", 2, 3, 4, 5, 6, "7+"] as const;

/** One stretch of one voice's words. Times are from the recording's start, in ms. */
export const TranscriptLineSchema = z.object({
  speaker: z.string().min(1).max(40),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  /** The user moved the line to its voice: it stays there. */
  pinned: z.boolean().optional(),
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
  /** The session's `done` (or `error`) `transcribeToken`, until it is used. */
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
  /** Names the user declined for each voice. */
  rejectedVoiceNames: z.record(z.string(), z.array(z.string().min(1).max(80))).optional(),
  /** The audio was deleted (the text stays). */
  audioRemoved: z.boolean().optional(),
  /** Its voices were told apart by voice print: keyed for the whole recording. */
  voicePrint: z.boolean().optional(),
  /** A participant count selected for this recording. Older recordings default to Auto. */
  participantCount: ParticipantCountSchema.optional(),
  /** The user dismissed the prompt to review the automatic speaker count. */
  speakerPromptDismissed: z.boolean().optional(),
  /** Display numbers once the recording ends. Keys still identify the original voices. */
  speakerNumbers: z.record(z.string(), z.string()).optional(),
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
  return [...new Set(recording.lines.map((line) => line.speaker))];
}

/** Compact speaker numbers in order of first speech, without changing voice identities. */
export function numberSpeakers(recording: TranscriptRecording): TranscriptRecording {
  const numbers = new Map<string, string>();
  const speakerNumbers = Object.fromEntries(
    speakersOf({ lines: [...recording.lines].sort((a, b) => a.startMs - b.startMs) }).map((key) => {
      const person = voicePerson(recording.speakers, key);
      const number = numbers.get(person) ?? String(numbers.size + 1);
      numbers.set(person, number);
      return [key, number];
    }),
  );
  return { ...recording, speakerNumbers };
}

/** How many people spoke: voices given one name count once. */
export function peopleIn(recording: Pick<TranscriptRecording, "lines" | "speakers">): number {
  return new Set(speakersOf(recording).map((key) => voicePerson(recording.speakers, key))).size;
}

/** The least number of people allowed by names and manual assignments. */
export function protectedVoiceCount(recording: TranscriptRecording): number {
  const protectedPeople = new Set<string>();
  for (const line of recording.lines) {
    if (line.pinned || recording.speakers[line.speaker]?.trim()) {
      protectedPeople.add(voicePerson(recording.speakers, line.speaker));
    }
  }
  return protectedPeople.size;
}

/** A small amount of speech in extra groups can indicate that one voice was split. */
export function shouldPromptSpeakerCount(recording: TranscriptRecording): boolean {
  if (recording.speakerPromptDismissed || recording.audioRemoved) return false;
  if (typeof recording.participantCount === "number") return false;
  const activity = new Map<string, number>();
  let total = 0;
  for (const line of recording.lines) {
    const person = voicePerson(recording.speakers, line.speaker);
    const ms = Math.max(0, line.endMs - line.startMs);
    activity.set(person, (activity.get(person) ?? 0) + ms);
    total += ms;
  }
  if (recording.participantCount === "7+") return activity.size >= 9;
  if (activity.size > 4) return true;
  const durations = [...activity.values()];
  return (
    activity.size >= 3 &&
    (durations.some((ms) => ms <= 1500) || durations.filter((ms) => ms < total * 0.05).length >= 2)
  );
}

/** A recording's length: its takes', or as far as its words go while a take is open. */
export function recordingMs(recording: Pick<TranscriptRecording, "takes" | "lines">): number {
  const takes = recording.takes.reduce((ms, t) => Math.max(ms, t.offsetMs + t.seconds * 1000), 0);
  const words = recording.lines.reduce((ms, l) => Math.max(ms, l.endMs), 0);
  return Math.max(takes, words);
}

/**
 * The names for a second pass's voices: each takes the name of the person
 * (as the live session had them) it shares the most time with, if that one
 * had a name. Live voices given one name are one person, the user said, and
 * an unnamed live voice is one of its own. A person's name goes to one new
 * voice only, the one that shares the most time with them: when the pass
 * hears two voices where the live session heard one, the other stays
 * unnamed, a person of its own, for the user to name (giving it the same
 * name joins it back). Named after the live person, it would be one person
 * with no way to tell them apart. That holds when the live session mixed
 * people up and the user gave its voices their names as they went: the
 * voices the pass tells apart do not go back to one name.
 */
export function carryNames(
  live: readonly TranscriptLine[],
  names: Readonly<Record<string, string>>,
  next: readonly TranscriptLine[],
): Record<string, string> {
  // A live voice's person: its name, or the voice itself when it has none.
  const overlap = new Map<string, Map<string, number>>();
  for (const n of next) {
    for (const l of live) {
      const shared = Math.min(n.endMs, l.endMs) - Math.max(n.startMs, l.startMs);
      if (shared <= 0) continue;
      const person = voicePerson(names, l.speaker);
      const byPerson = overlap.get(n.speaker) ?? new Map<string, number>();
      byPerson.set(person, (byPerson.get(person) ?? 0) + shared);
      overlap.set(n.speaker, byPerson);
    }
  }
  // Each new voice's live person, and the new voice that shares the most with each person.
  const heir = new Map<string, { speaker: string; ms: number }>();
  const personOfNew = new Map<string, string>();
  for (const [speaker, byPerson] of overlap) {
    let best = "";
    let most = 0;
    for (const [person, ms] of byPerson) {
      if (ms > most) {
        most = ms;
        best = person;
      }
    }
    personOfNew.set(speaker, best);
    const held = heir.get(best);
    if (!held || most > held.ms) heir.set(best, { speaker, ms: most });
  }
  const out: Record<string, string> = {};
  for (const [speaker, person] of personOfNew) {
    if (person.startsWith("name:") && heir.get(person)?.speaker === speaker) {
      out[speaker] = person.slice("name:".length);
    }
  }
  return out;
}

/**
 * A take's lines replaced by its second pass: the take's own lines go, the
 * pass's come in (moved to the take's place in the recording, their voices
 * keyed by the take), and names carry over by time. A recording told apart
 * by voice print keeps its voices instead: each new line takes the voice of
 * the lines it shares the most time with, since the server's labels mix
 * people up.
 */
export function withSecondPass(
  recording: TranscriptRecording,
  take: number,
  segments: readonly TranscriptLine[],
): TranscriptRecording {
  const t = recording.takes[take];
  if (!t) return recording;
  const until = recording.takes[take + 1]?.offsetMs ?? Number.POSITIVE_INFINITY;
  const inTake = (l: TranscriptLine) => l.startMs >= t.offsetMs && l.startMs < until;
  const old = recording.lines.filter(inTake);
  const rest = recording.lines.filter((l) => !inTake(l));
  if (recording.voicePrint) {
    return numberSpeakers(withSecondPassByVoice(recording, t, old, rest, segments));
  }

  const pinned = old.filter((l) => l.pinned);
  const retained = new Set([...rest, ...pinned].map((l) => l.speaker));
  const oldKeys = new Set(old.map((l) => l.speaker));
  const taken = new Set([
    ...Object.keys(recording.speakers),
    ...recording.lines.map((l) => l.speaker),
  ]);
  for (const s of segments) taken.add(speakerKey(take, s.speaker));
  const byLabel = new Map<string, string>();
  const keyOfLabel = (label: string) => {
    const original = speakerKey(take, label);
    if (!retained.has(original)) return original;
    const existing = byLabel.get(label);
    if (existing !== undefined) return existing;
    const key = nextVoiceKey(taken);
    taken.add(key);
    byLabel.set(label, key);
    return key;
  };
  const fresh = segments
    .filter((s) => s.text.trim())
    .map((s): TranscriptLine => {
      const startMs = t.offsetMs + s.startMs;
      const endMs = t.offsetMs + s.endMs;
      const manual = greatestOverlap(overlapBySpeaker(pinned, startMs, endMs));
      return {
        speaker: manual ?? keyOfLabel(s.speaker),
        startMs,
        endMs,
        text: s.text.trim(),
        ...(manual ? { pinned: true } : {}),
      };
    });
  const carried = carryNames(
    old,
    recording.speakers,
    fresh.filter((l) => !l.pinned),
  );
  const speakers: Record<string, string> = {};
  const keyInTake = (key: string) =>
    take === 0 ? !key.includes(".") : key.startsWith(`${take + 1}.`);
  for (const [key, name] of Object.entries(recording.speakers)) {
    if (retained.has(key) || (!oldKeys.has(key) && !keyInTake(key))) speakers[key] = name;
  }
  Object.assign(speakers, carried);
  return numberSpeakers({
    ...recording,
    speakers,
    lines: [...rest, ...fresh].sort((a, b) => a.startMs - b.startMs),
  });
}

function withSecondPassByVoice(
  recording: TranscriptRecording,
  take: TranscriptTake,
  old: readonly TranscriptLine[],
  rest: readonly TranscriptLine[],
  segments: readonly TranscriptLine[],
): TranscriptRecording {
  // A take the live session heard nothing in: the pass's labels, as new voices.
  const taken = new Set([
    ...recording.lines.map((l) => l.speaker),
    ...Object.keys(recording.speakers),
  ]);
  const limit =
    typeof recording.participantCount === "number" ? recording.participantCount : undefined;
  const existing = new Map(
    recording.lines.map((l) => [voicePerson(recording.speakers, l.speaker), l.speaker]),
  );
  const byLabel = new Map<string, string>();
  const keyOfLabel = (label: string) => {
    let key = byLabel.get(label);
    if (!key) {
      key =
        limit !== undefined && existing.size >= limit ? existing.values().next().value : undefined;
      key ??= nextVoiceKey(taken);
      taken.add(key);
      existing.set(voicePerson(recording.speakers, key), key);
      byLabel.set(label, key);
    }
    return key;
  };
  const fresh = segments
    .filter((s) => s.text.trim())
    .map((s): TranscriptLine => {
      const startMs = take.offsetMs + s.startMs;
      const endMs = take.offsetMs + s.endMs;
      const shared = new Map<string, number>();
      const pinned = new Map<string, number>();
      let near: TranscriptLine | null = null;
      for (const l of old) {
        const ms = Math.min(endMs, l.endMs) - Math.max(startMs, l.startMs);
        if (ms > 0) {
          shared.set(l.speaker, (shared.get(l.speaker) ?? 0) + ms);
          if (l.pinned) pinned.set(l.speaker, (pinned.get(l.speaker) ?? 0) + ms);
        }
        const gap = Math.abs((l.startMs + l.endMs) / 2 - (startMs + endMs) / 2);
        if (!near || gap < Math.abs((near.startMs + near.endMs) / 2 - (startMs + endMs) / 2))
          near = l;
      }
      const speaker =
        greatestOverlap(pinned.size ? pinned : shared) ?? near?.speaker ?? keyOfLabel(s.speaker);
      return {
        speaker,
        startMs,
        endMs,
        text: s.text.trim(),
        ...(pinned.size ? { pinned: true } : {}),
      };
    });
  return { ...recording, lines: [...rest, ...fresh].sort((a, b) => a.startMs - b.startMs) };
}

function overlapBySpeaker(
  lines: readonly TranscriptLine[],
  startMs: number,
  endMs: number,
): Map<string, number> {
  const shared = new Map<string, number>();
  for (const line of lines) {
    const ms = Math.min(endMs, line.endMs) - Math.max(startMs, line.startMs);
    if (ms > 0) shared.set(line.speaker, (shared.get(line.speaker) ?? 0) + ms);
  }
  return shared;
}

function greatestOverlap(shared: ReadonlyMap<string, number>): string | undefined {
  let speaker: string | undefined;
  let most = 0;
  for (const [key, ms] of shared) {
    if (ms <= most) continue;
    most = ms;
    speaker = key;
  }
  return speaker;
}

export type SpeakerMoveScope = "line" | "following" | "all";

/**
 * Move the selected lines to voice `to` and pin them there.
 */
export function movedLines(
  recording: TranscriptRecording,
  shown: Pick<TranscriptLine, "speaker" | "startMs" | "endMs">,
  to: string,
  scope: SpeakerMoveScope = "line",
): TranscriptRecording {
  const from = voicePerson(recording.speakers, shown.speaker);
  if (from === voicePerson(recording.speakers, to)) return recording;
  const first = recording.lines.findIndex(
    (l) => l.startMs === shown.startMs && l.speaker === shown.speaker,
  );
  if (first < 0) return recording;
  let until = first + 1;
  if (scope === "line") {
    while (until < recording.lines.length) {
      const line = recording.lines[until] as TranscriptLine;
      if (line.speaker !== shown.speaker || line.startMs > shown.endMs || line.endMs > shown.endMs)
        break;
      until++;
    }
  }
  const lines = recording.lines.map((l, i) => {
    const selected =
      scope === "line"
        ? i >= first && i < until
        : voicePerson(recording.speakers, l.speaker) === from && (scope === "all" || i >= first);
    if (!selected) return l;
    return { ...l, speaker: to, pinned: true };
  });
  let speakers = recording.speakers;
  if (scope === "all") {
    speakers = { ...recording.speakers };
    for (const key of Object.keys(speakers)) {
      if (voicePerson(recording.speakers, key) === from) delete speakers[key];
    }
    const sourceName = recording.speakers[shown.speaker]?.trim();
    if (sourceName && !speakers[to]?.trim()) speakers[to] = sourceName;
  }
  const next = { ...recording, lines, speakers };
  return recording.speakerNumbers ? numberSpeakers(next) : next;
}

/** A key for a new voice of the recording: the next number not taken. */
export function newSpeakerKey(recording: Pick<TranscriptRecording, "lines" | "speakers">): string {
  return nextVoiceKey([
    ...recording.lines.map((l) => l.speaker),
    ...Object.keys(recording.speakers),
  ]);
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
  recording: Pick<TranscriptRecording, "speakers" | "speakerNumbers">,
  key: string,
  unnamed: (label: string) => string = (label) => `Speaker ${label}`,
): string {
  return recording.speakers[key]?.trim() || unnamed(recording.speakerNumbers?.[key] ?? key);
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
