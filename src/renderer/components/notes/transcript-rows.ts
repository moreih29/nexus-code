/**
 * What a note's transcript panel shows, worked out apart from drawing it:
 * each recording's people (voices given one name are one person), and the
 * rows it lists, a recording's heading and then its lines, as a speaker
 * picked and words searched for leave them. Pure.
 */
import {
  joinedLines,
  speakersOf,
  type TranscriptLine,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { findMatches } from "../../services/editor/preview/find/find-matches";

/** Voice keys in order: numbers as numbers ("2" before "10"). */
const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** As many matches in a line as are marked. */
const MARKS_PER_LINE = 50;

/** A line's marks when nothing is searched for: one array, so a row drawn again is the same. */
const NO_MARKS: readonly number[] = [];

/** The people's colors, by a person's color index. */
const SPEAKER_COLORS = [
  "var(--state-info-fg)",
  "var(--state-success-fg)",
  "var(--state-warning-fg)",
  "var(--primary)",
  "var(--state-error-fg)",
  "var(--muted-foreground)",
];

/** A person's color, by their color index (Cast). */
export function speakerColor(index: number): string {
  return SPEAKER_COLORS[
    ((index % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length
  ] as string;
}

/** A voice's person: the name it was given, or "#<key>" for a voice with none. */
export function personOf(recording: Pick<TranscriptRecording, "speakers">, key: string): string {
  return recording.speakers[key]?.trim() || `#${key}`;
}

/** Whether a person is a name the user gave, not an unnamed voice. */
export function isNamed(person: string): boolean {
  return !person.startsWith("#");
}

/** One person of a recording: their voices, and the place of their color. */
export interface Person {
  readonly person: string;
  /** Their voices, in order. */
  readonly keys: readonly string[];
  /** Index into the panel's colors (wrapped by it). */
  readonly color: number;
}

/** A recording's people, and whose a voice is. */
export interface Cast {
  readonly people: readonly Person[];
  /** The person a voice is. */
  readonly personOf: (key: string) => string;
  /** The color index of a voice's person. */
  readonly colorOf: (key: string) => number;
}

/**
 * A recording's people, in their voices' order rather than the order they
 * first spoke in, so moving a line doesn't reorder or recolor them. `extra`
 * is a voice speaking now, before any line of it is final. Numbered voices
 * (a voice print recording's) keep their number's color, whoever else comes
 * or goes.
 */
export function castOf(
  recording: Pick<TranscriptRecording, "lines" | "speakers">,
  extra?: string | null,
): Cast {
  const voices = speakersOf(recording);
  if (extra && !voices.includes(extra)) voices.push(extra);
  const ofKey = (key: string) => personOf(recording, key);
  const grouped = [...new Set(voices.map(ofKey))]
    .map((person) => ({ person, keys: voices.filter((k) => ofKey(k) === person).sort(byKey) }))
    .sort((a, b) => byKey(a.keys[0] as string, b.keys[0] as string));
  const numbered = voices.every((k) => /^[1-9]\d*$/.test(k));
  const people = grouped.map((p, index) => ({
    ...p,
    color: numbered ? Number(p.keys[0]) - 1 : index,
  }));
  const colors = new Map(people.map((p) => [p.person, p.color]));
  return {
    people,
    personOf: ofKey,
    colorOf: (key) => colors.get(ofKey(key)) ?? 0,
  };
}

/**
 * The person whose lines alone are shown: picked in a recording. A person
 * with a name is the same person in every recording of the note; a voice
 * with none is one only in its own.
 */
export interface SpeakerFilter {
  readonly recordingId: string;
  readonly person: string;
}

/** Whether `person` of `recordingId` is the one picked. */
export function isPicked(
  filter: SpeakerFilter | null,
  recordingId: string,
  person: string,
): boolean {
  if (!filter || filter.person !== person) return false;
  return isNamed(person) || filter.recordingId === recordingId;
}

/** What the panel is narrowed to: a person, and words searched for. */
export interface TranscriptView {
  readonly speaker: SpeakerFilter | null;
  readonly query: string;
}

export const WHOLE_TRANSCRIPT: TranscriptView = { speaker: null, query: "" };

/** Whether the view leaves lines out. */
export function isNarrowed(view: TranscriptView): boolean {
  return view.speaker !== null || view.query.trim() !== "";
}

/** A recording, with its lines run together as they read. */
export interface ReadRecording {
  readonly recording: TranscriptRecording;
  readonly lines: readonly TranscriptLine[];
}

/** Each recording's lines run together, as the transcript reads (joinedLines). */
export function readRecordings(recordings: readonly TranscriptRecording[]): ReadRecording[] {
  return recordings.map((recording) => ({ recording, lines: joinedLines(recording.lines) }));
}

/** A line's key: its recording, its voice and its start, as long as it is not moved. */
export function lineKey(recordingId: string, line: Pick<TranscriptLine, "speaker" | "startMs">) {
  return `${recordingId}:${line.speaker}-${line.startMs}`;
}

export type TranscriptRow =
  /** A recording's heading: when, how long, its people. Always shown. */
  | { readonly kind: "recording"; readonly key: string; readonly recording: TranscriptRecording }
  | {
      readonly kind: "line";
      readonly key: string;
      readonly recording: TranscriptRecording;
      readonly line: TranscriptLine;
      /** Where the words searched for are in its text: [start, end] offsets one after another. */
      readonly marks: readonly number[];
    }
  /** The words being said now, in the recording that records. */
  | {
      readonly kind: "partial";
      readonly key: string;
      readonly recording: TranscriptRecording;
      readonly speaker: string;
      readonly text: string;
      readonly marks: readonly number[];
    }
  /** A recording with no words: listening, or nothing was heard. */
  | { readonly kind: "quiet"; readonly key: string; readonly recording: TranscriptRecording };

/** What is said now, in the recording that records. */
export interface LiveWords {
  readonly recordingId: string | null;
  readonly partial: { readonly speaker: string; readonly text: string } | null;
}

/**
 * The rows the panel lists, and how many lines the view leaves: each
 * recording's heading, then its lines of the person picked that have the
 * words searched for (any case; a space in them stands for any run of
 * white space), each with where those words are.
 */
export function transcriptRows(
  recordings: readonly ReadRecording[],
  view: TranscriptView,
  live: LiveWords,
): { rows: TranscriptRow[]; matches: number } {
  const query = view.query.trim();
  const rows: TranscriptRow[] = [];
  let matches = 0;
  const marksIn = (text: string): readonly number[] | null => {
    if (!query) return NO_MARKS;
    const found = findMatches(text, query, false, MARKS_PER_LINE);
    return found.length ? found : null;
  };
  for (const { recording, lines } of recordings) {
    rows.push({ kind: "recording", key: `${recording.id}:heading`, recording });
    const picked = (key: string) =>
      !view.speaker || isPicked(view.speaker, recording.id, personOf(recording, key));
    for (const line of lines) {
      if (!picked(line.speaker)) continue;
      const marks = marksIn(line.text);
      if (!marks) continue;
      matches++;
      rows.push({ kind: "line", key: lineKey(recording.id, line), recording, line, marks });
    }
    const partial = live.recordingId === recording.id ? live.partial : null;
    if (partial && picked(partial.speaker)) {
      const marks = marksIn(partial.text);
      if (marks) {
        rows.push({
          kind: "partial",
          key: `${recording.id}:partial`,
          recording,
          ...partial,
          marks,
        });
      }
    }
    if (lines.length === 0 && !partial) {
      rows.push({ kind: "quiet", key: `${recording.id}:quiet`, recording });
    }
  }
  return { rows, matches };
}
