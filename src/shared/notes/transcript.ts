import { z } from "zod";
import {
  NonnegativeNumberSchema,
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { nextVoiceKey, voicePerson } from "./voices";

export const TRANSCRIPT_VERSION = 1;

export const RECORDING_ID_RE = /^r[0-9a-z]{6,12}[0-9a-f]{4}$/;

export const TAKE_FILE_RE = /^recordings\/r[0-9a-z]{6,12}[0-9a-f]{4}-\d{1,3}\.(webm|ogg)$/;

export const ParticipantCountSchema = z.union([
  z.literal("auto"),
  z.literal("7+"),
  PositiveIntegerSchema,
]);
export type ParticipantCount = z.infer<typeof ParticipantCountSchema>;

export const PARTICIPANT_OPTIONS = ["auto", 2, 3, 4, 5, 6, "7+"] as const;

export const TranscriptLineSchema = z.object({
  speaker: z.string().min(1).max(40),
  startMs: NonnegativeNumberSchema,
  endMs: NonnegativeNumberSchema,
  text: z.string(),
  pinned: z.boolean().optional(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const TakePassSchema = z.enum(["none", "pending", "done", "error"]);
export type TakePass = z.infer<typeof TakePassSchema>;

export const TranscriptTakeSchema = z.object({
  file: z.string().regex(TAKE_FILE_RE),
  offsetMs: NonnegativeNumberSchema,
  seconds: NonnegativeNumberSchema,
  token: z.string().optional(),
  transcriptionId: z.string().optional(),
  pass: TakePassSchema,
});
export type TranscriptTake = z.infer<typeof TranscriptTakeSchema>;

export const TranscriptRecordingSchema = z.object({
  id: z.string().regex(RECORDING_ID_RE),
  startedAt: NumberSchema,
  language: z.string(),
  takes: z.array(TranscriptTakeSchema),
  speakers: z.record(z.string(), z.string()),
  lines: z.array(TranscriptLineSchema),
  rejectedVoiceNames: z.record(z.string(), z.array(z.string().min(1).max(80))).optional(),
  audioRemoved: z.boolean().optional(),
  voicePrint: z.boolean().optional(),
  participantCount: ParticipantCountSchema.optional(),
  speakerPromptDismissed: z.boolean().optional(),
  speakerNumbers: z.record(z.string(), z.string()).optional(),
});
export type TranscriptRecording = z.infer<typeof TranscriptRecordingSchema>;

export const TranscriptEditSchema = z.object({
  id: z.string().regex(RECORDING_ID_RE),
  before: TranscriptRecordingSchema.optional(),
  after: TranscriptRecordingSchema.optional(),
});
export type TranscriptEdit = z.infer<typeof TranscriptEditSchema>;

export const TranscriptFileSchema = z.object({
  version: z.literal(TRANSCRIPT_VERSION),
  recordings: z.array(TranscriptRecordingSchema),
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export const EMPTY_TRANSCRIPT: TranscriptFile = { version: TRANSCRIPT_VERSION, recordings: [] };

export function speakerKey(take: number, label: string): string {
  return take === 0 ? label : `${take + 1}.${label}`;
}

export function takeFile(recordingId: string, take: number): string {
  return `recordings/${recordingId}-${take + 1}.webm`;
}

export function speakersOf(recording: Pick<TranscriptRecording, "lines">): string[] {
  return [...new Set(recording.lines.map((line) => line.speaker))];
}

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

export function peopleIn(recording: Pick<TranscriptRecording, "lines" | "speakers">): number {
  return new Set(speakersOf(recording).map((key) => voicePerson(recording.speakers, key))).size;
}

export function protectedVoiceCount(recording: TranscriptRecording): number {
  const protectedPeople = new Set<string>();
  for (const line of recording.lines) {
    if (line.pinned || recording.speakers[line.speaker]?.trim()) {
      protectedPeople.add(voicePerson(recording.speakers, line.speaker));
    }
  }
  return protectedPeople.size;
}

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

export function asksSpeakerCount(recording: TranscriptRecording, voicePrint: boolean): boolean {
  return (
    voicePrint &&
    recording.takes.length > 0 &&
    recording.lines.length > 0 &&
    shouldPromptSpeakerCount(recording)
  );
}

export function recordingMs(recording: Pick<TranscriptRecording, "takes" | "lines">): number {
  const takes = recording.takes.reduce((ms, t) => Math.max(ms, t.offsetMs + t.seconds * 1000), 0);
  const words = recording.lines.reduce((ms, l) => Math.max(ms, l.endMs), 0);
  return Math.max(takes, words);
}

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
      const person = voicePerson(names, l.speaker);
      const byPerson = overlap.get(n.speaker) ?? new Map<string, number>();
      byPerson.set(person, (byPerson.get(person) ?? 0) + shared);
      overlap.set(n.speaker, byPerson);
    }
  }
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

export function withSecondPass(
  recording: TranscriptRecording,
  take: number,
  segments: readonly TranscriptLine[],
): TranscriptRecording {
  const t = recording.takes[take];
  if (!t) return recording;
  const words = segments.filter((segment) => segment.text.trim());
  if (!words.length) return recording;
  const until = recording.takes[take + 1]?.offsetMs ?? Number.POSITIVE_INFINITY;
  const inTake = (l: TranscriptLine) => l.startMs >= t.offsetMs && l.startMs < until;
  const old = recording.lines.filter(inTake);
  const rest = recording.lines.filter((l) => !inTake(l));
  if (recording.voicePrint) {
    return numberSpeakers(withSecondPassByVoice(recording, t, old, rest, words));
  }

  const pinned = old.filter((l) => l.pinned);
  const retained = new Set([...rest, ...pinned].map((l) => l.speaker));
  const oldKeys = new Set(old.map((l) => l.speaker));
  const taken = new Set([
    ...Object.keys(recording.speakers),
    ...recording.lines.map((l) => l.speaker),
  ]);
  for (const s of words) taken.add(speakerKey(take, s.speaker));
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
  const fresh = words.map((s): TranscriptLine => {
    const startMs = t.offsetMs + s.startMs;
    const endMs = t.offsetMs + s.endMs;
    const manual = pinnedSpeaker(overlapBySpeaker(pinned, startMs, endMs), endMs - startMs);
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
  const fresh = segments.map((s): TranscriptLine => {
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
    const manual = pinnedSpeaker(pinned, endMs - startMs);
    const speaker = manual ?? greatestOverlap(shared) ?? near?.speaker ?? keyOfLabel(s.speaker);
    return {
      speaker,
      startMs,
      endMs,
      text: s.text.trim(),
      ...(manual ? { pinned: true } : {}),
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

function pinnedSpeaker(
  shared: ReadonlyMap<string, number>,
  durationMs: number,
): string | undefined {
  const speaker = greatestOverlap(shared);
  return speaker && (shared.get(speaker) ?? 0) >= durationMs / 4 ? speaker : undefined;
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
  let rejected = recording.rejectedVoiceNames;
  if (scope === "all") {
    speakers = { ...recording.speakers };
    for (const key of Object.keys(speakers)) {
      if (voicePerson(recording.speakers, key) === from) delete speakers[key];
    }
    const sourceName = recording.speakers[shown.speaker]?.trim();
    if (sourceName && !speakers[to]?.trim()) speakers[to] = sourceName;
    if (rejected) {
      rejected = { ...rejected };
      const toNames = new Set(Object.hasOwn(rejected, to) ? rejected[to] : []);
      for (const [key, names] of Object.entries(rejected)) {
        if (voicePerson(recording.speakers, key) !== from) continue;
        for (const name of names) toNames.add(name);
        delete rejected[key];
      }
      if (toNames.size) rejected = { ...rejected, [to]: [...toNames] };
    }
  }
  const next = {
    ...recording,
    lines,
    speakers,
    ...(rejected ? { rejectedVoiceNames: rejected } : {}),
  };
  return recording.speakerNumbers ? numberSpeakers(next) : next;
}

export function withRejectedVoiceName(
  recording: TranscriptRecording,
  key: string,
  name: string,
): TranscriptRecording {
  const rejected = Object.hasOwn(recording.rejectedVoiceNames ?? {}, key)
    ? (recording.rejectedVoiceNames?.[key] ?? [])
    : [];
  if (rejected.includes(name)) return recording;
  return {
    ...recording,
    rejectedVoiceNames: { ...recording.rejectedVoiceNames, [key]: [...rejected, name] },
  };
}

export function newSpeakerKey(recording: Pick<TranscriptRecording, "lines" | "speakers">): string {
  return nextVoiceKey([
    ...recording.lines.map((l) => l.speaker),
    ...Object.keys(recording.speakers),
  ]);
}

export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function speakerName(
  recording: Pick<TranscriptRecording, "speakers" | "speakerNumbers">,
  key: string,
  unnamed: (label: string) => string = (label) => `Speaker ${label}`,
): string {
  return recording.speakers[key]?.trim() || unnamed(recording.speakerNumbers?.[key] ?? key);
}

export function transcriptLinesForCli(recording: TranscriptRecording) {
  const occurrences = new Map<string, number>();
  return recording.lines.map(({ speaker, startMs, endMs, text }) => {
    const times = `${startMs}:${endMs}`;
    const occurrence = (occurrences.get(times) ?? 0) + 1;
    occurrences.set(times, occurrence);
    return {
      id: `${times}:${occurrence}`,
      startMs,
      endMs,
      speaker,
      speakerLabel: `Speaker ${recording.speakerNumbers?.[speaker] ?? speaker}`,
      speakerName: recording.speakers[speaker]?.trim() || null,
      text,
    };
  });
}

export function joinedLines<T extends TranscriptLine>(lines: readonly T[], gapMs = 4000): T[] {
  const out: T[] = [];
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

interface SpokenLine extends TranscriptLine {
  name: string;
}

interface SpokenRecording {
  startedAt: number;
  ms: number;
  lines: readonly SpokenLine[];
}

function spokenMarkdown(title: string, recordings: readonly SpokenRecording[]): string {
  const out: string[] = [`# Transcript${title.trim() ? `: ${title.trim()}` : ""}`];
  for (const rec of recordings) {
    out.push("", `## Recording ${dateOf(rec.startedAt)} (${clockOf(rec.ms)})`, "");
    const lines = joinedLines(rec.lines);
    if (!lines.length) out.push("(nothing heard)");
    for (const line of lines) {
      out.push(`[${clockOf(line.startMs)}] ${line.name}: ${line.text}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function transcriptMarkdown(file: TranscriptFile, title: string): string {
  return spokenMarkdown(
    title,
    file.recordings.map((rec) => ({
      startedAt: rec.startedAt,
      ms: recordingMs(rec),
      lines: rec.lines.map((line) => ({ ...line, name: speakerName(rec, line.speaker) })),
    })),
  );
}

export interface CliTranscriptRecording {
  startedAt: number;
  ms: number;
  lines: readonly ReturnType<typeof transcriptLinesForCli>[number][];
}

export function cliTranscriptMarkdown(
  title: string,
  recordings: readonly CliTranscriptRecording[],
): string {
  return spokenMarkdown(
    title,
    recordings.map(({ startedAt, ms, lines }) => ({
      startedAt,
      ms,
      lines: lines.map(({ speaker, startMs, endMs, text, speakerName, speakerLabel }) => ({
        speaker,
        startMs,
        endMs,
        text,
        name: speakerName ?? speakerLabel,
      })),
    })),
  );
}

export interface ReadTranscriptRecording {
  id: string;
  startedAt: number;
  ms: number;
  participants?: ParticipantCount;
  lines: readonly Pick<
    CliTranscriptRecording["lines"][number],
    "speaker" | "speakerLabel" | "speakerName" | "startMs" | "endMs" | "text"
  >[];
}

const UNNAMED_SPEAKER = /^Speaker (\S{1,40})$/;

export function readTranscriptRecording(read: ReadTranscriptRecording): TranscriptRecording {
  const speakers: Record<string, string> = {};
  const speakerNumbers: Record<string, string> = {};
  for (const line of read.lines) {
    if (line.speakerName) speakers[line.speaker] = line.speakerName;
    const label = UNNAMED_SPEAKER.exec(line.speakerLabel)?.[1];
    if (label && label !== line.speaker) speakerNumbers[line.speaker] = label;
  }
  return {
    id: read.id,
    startedAt: read.startedAt,
    language: "",
    takes: [],
    speakers,
    lines: read.lines.map(({ speaker, startMs, endMs, text }) => ({
      speaker,
      startMs,
      endMs,
      text,
    })),
    ...(Object.keys(speakerNumbers).length ? { speakerNumbers } : {}),
    ...(read.participants === undefined ? {} : { participantCount: read.participants }),
  };
}

const RECORDING_HEADING =
  /^## Recording (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) \(((?:\d+:)?\d{1,2}:\d{2})\)$/;
const SPOKEN_LINE = /^\[((?:\d+:)?\d{1,2}:\d{2})\] (.+?): (.*)$/;

function clockMs(clock: string): number {
  return clock.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

interface HeardLine {
  name: string;
  at: number;
  text: string;
}

export function transcriptFromMarkdown(markdown: string): ReadTranscriptRecording[] {
  const heard: { startedAt: number; ms: number; lines: HeardLine[] }[] = [];
  for (const row of markdown.split(/\r?\n/)) {
    const heading = RECORDING_HEADING.exec(row);
    if (heading) {
      const [y, mo, d, h, mi] = heading.slice(1, 6).map(Number) as [
        number,
        number,
        number,
        number,
        number,
      ];
      heard.push({
        startedAt: new Date(y, mo - 1, d, h, mi).getTime(),
        ms: clockMs(heading[6] ?? ""),
        lines: [],
      });
      continue;
    }
    const recording = heard.at(-1);
    if (!recording) continue;
    const spoken = SPOKEN_LINE.exec(row);
    if (spoken) {
      recording.lines.push({
        name: spoken[2] ?? "",
        at: clockMs(spoken[1] ?? ""),
        text: spoken[3] ?? "",
      });
      continue;
    }
    const last = recording.lines.at(-1);
    if (last && row.trim()) last.text = `${last.text} ${row.trim()}`;
  }
  return heard.map((recording, index) => {
    const keys = new Map<string, string>();
    const taken = new Set<string>();
    for (const { name } of recording.lines) {
      const label = UNNAMED_SPEAKER.exec(name)?.[1];
      if (label && /^[1-9]\d*$/.test(label) && !taken.has(label)) {
        keys.set(name, label);
        taken.add(label);
      }
    }
    let next = 1;
    for (const { name } of recording.lines) {
      if (keys.has(name)) continue;
      while (taken.has(String(next))) next++;
      keys.set(name, String(next));
      taken.add(String(next));
    }
    return {
      id: `markdown-${index + 1}`,
      startedAt: recording.startedAt,
      ms: recording.ms,
      lines: recording.lines.map(({ name, at, text }) => {
        const speaker = keys.get(name) as string;
        const unnamed = UNNAMED_SPEAKER.test(name);
        return {
          speaker,
          speakerLabel: unnamed ? name : `Speaker ${speaker}`,
          speakerName: unnamed ? null : name,
          startMs: at,
          endMs: at,
          text,
        };
      }),
    };
  });
}
