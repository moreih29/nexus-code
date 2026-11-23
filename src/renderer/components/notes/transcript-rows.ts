import { summaryOrigin } from "../../../shared/notes/summary";
import {
  joinedLines,
  speakerName,
  speakersOf,
  type TranscriptLine,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { findMatches } from "../../services/editor/preview/find/find-matches";

const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const MARKS_PER_LINE = 50;

const NO_MARKS: readonly number[] = [];

const SPEAKER_COLORS = [
  "var(--state-info-fg)",
  "var(--state-success-fg)",
  "var(--state-warning-fg)",
  "var(--color-git-lane-6)",
  "var(--state-error-fg)",
  "var(--muted-foreground)",
];

export function speakerColor(index: number): string {
  return SPEAKER_COLORS[
    ((index % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length
  ] as string;
}

export function personOf(recording: Pick<TranscriptRecording, "speakers">, key: string): string {
  return recording.speakers[key]?.trim() || `#${key}`;
}

export function isNamed(person: string): boolean {
  return !person.startsWith("#");
}

export interface Person {
  readonly person: string;
  readonly keys: readonly string[];
  readonly color: number;
}

export interface Cast {
  readonly people: readonly Person[];
  readonly personOf: (key: string) => string;
  readonly colorOf: (key: string) => number;
}

export function castOf(
  recording: Pick<TranscriptRecording, "lines" | "speakers" | "speakerNumbers">,
  extra?: string | null,
): Cast {
  const voices = speakersOf(recording);
  if (extra && !voices.includes(extra)) voices.push(extra);
  const ofKey = (key: string) => personOf(recording, key);
  const numberOf = (key: string) => recording.speakerNumbers?.[key] ?? key;
  const grouped = [...new Set(voices.map(ofKey))]
    .map((person) => ({ person, keys: voices.filter((k) => ofKey(k) === person).sort(byKey) }))
    .sort((a, b) => byKey(numberOf(a.keys[0] as string), numberOf(b.keys[0] as string)));
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

export interface SpeakerFilter {
  readonly recordingId: string;
  readonly person: string;
}

export function isPicked(
  filter: SpeakerFilter | null,
  recordingId: string,
  person: string,
): boolean {
  if (!filter || filter.person !== person) return false;
  return isNamed(person) || filter.recordingId === recordingId;
}

export interface TranscriptView {
  readonly speaker: SpeakerFilter | null;
  readonly query: string;
}

export const WHOLE_TRANSCRIPT: TranscriptView = { speaker: null, query: "" };

export function isNarrowed(view: TranscriptView): boolean {
  return view.speaker !== null || view.query.trim() !== "";
}

export interface ReadRecording {
  readonly recording: TranscriptRecording;
  readonly lines: readonly TranscriptLine[];
}

export function readRecordings(recordings: readonly TranscriptRecording[]): ReadRecording[] {
  return recordings.map((recording) => ({ recording, lines: joinedLines(recording.lines) }));
}

export function lineKey(recordingId: string, line: Pick<TranscriptLine, "speaker" | "startMs">) {
  return `${recordingId}:${line.speaker}-${line.startMs}`;
}

export interface TranscriptJump {
  speaker: string;
  at: number;
  origin?: string;
}

export function transcriptJumpKey(
  read: readonly ReadRecording[],
  jump: TranscriptJump,
): string | undefined {
  const recordings = jump.origin
    ? read.filter(({ recording }) => summaryOrigin(recording.id) === jump.origin)
    : read;
  let closest: { key: string; distance: number; sameSpeaker: boolean } | undefined;
  for (const { recording, lines } of recordings) {
    const source = recording.lines.find((line) => Math.round(line.startMs) === jump.at);
    for (const line of lines) {
      const sameSpeaker =
        source?.speaker === line.speaker ||
        Boolean(jump.speaker && speakerName(recording, line.speaker) === jump.speaker);
      const distance = Math.max(line.startMs - jump.at, jump.at - line.endMs, 0);
      if (
        !closest ||
        distance < closest.distance ||
        (distance === closest.distance && sameSpeaker && !closest.sameSpeaker)
      ) {
        closest = { key: lineKey(recording.id, line), distance, sameSpeaker };
      }
    }
  }
  return closest?.key;
}

export type TranscriptRow =
  | { readonly kind: "recording"; readonly key: string; readonly recording: TranscriptRecording }
  | {
      readonly kind: "line";
      readonly key: string;
      readonly recording: TranscriptRecording;
      readonly line: TranscriptLine;
      readonly marks: readonly number[];
    }
  | {
      readonly kind: "partial";
      readonly key: string;
      readonly recording: TranscriptRecording;
      readonly speaker: string;
      readonly text: string;
      readonly marks: readonly number[];
    }
  | {
      readonly kind: "accept-suggestions";
      readonly key: string;
      readonly recording: TranscriptRecording;
    }
  | { readonly kind: "quiet"; readonly key: string; readonly recording: TranscriptRecording };

export interface LiveWords {
  readonly recordingId: string | null;
  readonly partial: { readonly speaker: string; readonly text: string } | null;
}

export function transcriptRows(
  recordings: readonly ReadRecording[],
  view: TranscriptView,
  live: LiveWords,
  bulkSuggestions?: ReadonlySet<string>,
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
    if (bulkSuggestions?.has(recording.id)) {
      rows.push({
        kind: "accept-suggestions",
        key: `${recording.id}:accept-suggestions`,
        recording,
      });
    }
  }
  return { rows, matches };
}
