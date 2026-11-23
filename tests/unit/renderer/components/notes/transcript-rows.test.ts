import { describe, expect, test } from "bun:test";
import {
  castOf,
  lineKey,
  readRecordings,
  type TranscriptRow,
  type TranscriptView,
  transcriptJumpKey,
  transcriptRows,
  WHOLE_TRANSCRIPT,
} from "../../../../../src/renderer/components/notes/transcript-rows";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";

const line = (speaker: string, startMs: number, text: string) => ({
  speaker,
  startMs,
  endMs: startMs + 1000,
  text,
});

function recording(id: string, over: Partial<TranscriptRecording> = {}): TranscriptRecording {
  return {
    id,
    startedAt: 0,
    language: "ko",
    takes: [],
    speakers: {},
    lines: [],
    ...over,
  };
}

const first = recording("rmhz00cc0aaaa", {
  speakers: { "1": "지현", "3": "지현" },
  lines: [
    line("1", 0, "Release on Friday"),
    line("2", 10_000, "the release notes are late"),
    line("3", 20_000, "Then Monday"),
  ],
});
const second = recording("rmhz00cc0bbbb", {
  speakers: { "1": "지현" },
  lines: [line("1", 0, "About the budget"), line("2", 10_000, "budget RELEASE")],
});
const read = readRecordings([first, second]);
const noLive = { recordingId: null, partial: null };

function shown(rows: readonly TranscriptRow[]): string[] {
  return rows.map((row) => {
    const rec = row.recording === first ? "A" : "B";
    if (row.kind === "line") return `${rec}:${row.line.speaker}@${row.line.startMs / 1000}`;
    if (row.kind === "partial") return `${rec}:partial`;
    return row.kind === "recording" ? rec : `${rec}:${row.kind}`;
  });
}

describe("the transcript's rows", () => {
  test("the whole transcript: each recording's heading, then its lines", () => {
    const { rows } = transcriptRows(read, WHOLE_TRANSCRIPT, noLive);
    expect(shown(rows)).toEqual(["A", "A:1@0", "A:2@10", "A:3@20", "B", "B:1@0", "B:2@10"]);
  });

  test.each<[string, TranscriptView, string[], number]>([
    [
      "a named person: their voices, in every recording",
      { speaker: { recordingId: first.id, person: "지현" }, query: "" },
      ["A", "A:1@0", "A:3@20", "B", "B:1@0"],
      3,
    ],
    [
      "an unnamed voice: in its own recording only",
      { speaker: { recordingId: first.id, person: "#2" }, query: "" },
      ["A", "A:2@10", "B"],
      1,
    ],
    [
      "words searched for, in any case",
      { speaker: null, query: "release" },
      ["A", "A:1@0", "A:2@10", "B", "B:2@10"],
      3,
    ],
    [
      "a person and words at once",
      { speaker: { recordingId: second.id, person: "지현" }, query: "  release " },
      ["A", "A:1@0", "B"],
      1,
    ],
  ])("narrowed to %s", (_label, view, rows, matches) => {
    const out = transcriptRows(read, view, noLive);
    expect(shown(out.rows)).toEqual(rows);
    expect(out.matches).toBe(matches);
  });

  test("marks where the words searched for are", () => {
    const { rows } = transcriptRows(read, { speaker: null, query: "Budget" }, noLive);
    const marks = rows.flatMap((row) => (row.kind === "line" ? [row.marks] : []));
    expect(marks).toEqual([
      [10, 16],
      [0, 6],
    ]);
  });

  test("the words said now go under their recording, as the view leaves them", () => {
    const live = { recordingId: second.id, partial: { speaker: "2", text: "and the budget" } };
    expect(shown(transcriptRows(read, WHOLE_TRANSCRIPT, live).rows).slice(-1)).toEqual([
      "B:partial",
    ]);
    const someoneElse = { speaker: { recordingId: second.id, person: "지현" }, query: "" };
    expect(shown(transcriptRows(read, someoneElse, live).rows)).not.toContain("B:partial");
    const empty = readRecordings([recording("rmhz00cc0cccc")]);
    expect(transcriptRows(empty, WHOLE_TRANSCRIPT, noLive).rows.map((r) => r.kind)).toEqual([
      "recording",
      "quiet",
    ]);
  });
});

describe("a recording's people", () => {
  test("voices given one name are one person, in their voices' order", () => {
    const cast = castOf(first);
    expect(cast.people.map((p) => [p.person, p.keys])).toEqual([
      ["지현", ["1", "3"]],
      ["#2", ["2"]],
    ]);
    expect(cast.colorOf("3")).toBe(cast.colorOf("1"));
  });

  test("a voice speaking now is one of them before a line of it is final", () => {
    expect(castOf(first, "4").people.map((p) => p.person)).toContain("#4");
  });

  test("numbered voices keep their number's color whoever else comes or goes", () => {
    const later = recording("rmhz00cc0dddd", { lines: [line("3", 0, "a"), line("5", 1000, "b")] });
    expect(castOf(later).colorOf("5")).toBe(4);
    const taken = recording("rmhz00cc0dddd", { lines: [line("1.1", 0, "a"), line("2", 1, "b")] });
    expect(castOf(taken).colorOf("2")).toBe(1);
  });
});

test("a to-do source opens the right recording and the joined line containing its timestamp", () => {
  const source = recording("rmhz00cc0cccc", {
    speakers: { "2": "한여울" },
    lines: [line("2", 8_000, "Look at"), line("2", 10_000, "the logs")],
  });
  expect(
    transcriptJumpKey(readRecordings([first, second, source]), {
      speaker: "한여울",
      at: 10_000,
      origin: `summary:${source.id}`,
    }),
  ).toBe(lineKey(source.id, source.lines[0]));
});
