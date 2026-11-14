import { describe, expect, test } from "bun:test";
import {
  carryNames,
  clockOf,
  joinedLines,
  peopleIn,
  recordingMs,
  speakerKey,
  speakersOf,
  TAKE_FILE_RE,
  TranscriptFileSchema,
  type TranscriptRecording,
  takeFile,
  transcriptMarkdown,
  withSecondPass,
} from "../../../../src/shared/notes/transcript";

const line = (speaker: string, startMs: number, endMs: number, text: string) => ({
  speaker,
  startMs,
  endMs,
  text,
});

function recording(over: Partial<TranscriptRecording> = {}): TranscriptRecording {
  return {
    id: "rmhz00cc0abcd",
    startedAt: new Date(2026, 10, 14, 20, 30).getTime(),
    language: "ko",
    takes: [{ file: "recordings/rmhz00cc0abcd-1.webm", offsetMs: 0, seconds: 60, pass: "none" }],
    speakers: {},
    lines: [],
    ...over,
  };
}

describe("a note's transcript", () => {
  test("keys a voice by its take, and names a take's file", () => {
    expect(speakerKey(0, "1")).toBe("1");
    expect(speakerKey(1, "1")).toBe("2.1");
    expect(takeFile("rmhz00cc0abcd", 0)).toBe("recordings/rmhz00cc0abcd-1.webm");
    expect(TAKE_FILE_RE.test(takeFile("rmhz00cc0abcd", 2))).toBe(true);
    expect(TAKE_FILE_RE.test("recordings/../note.json")).toBe(false);
  });

  test("counts people by name: two voices given one name are one person", () => {
    const r = recording({
      lines: [line("1", 0, 1000, "a"), line("2", 1000, 2000, "b"), line("2.1", 70000, 71000, "c")],
      speakers: { "1": "지현", "2.1": "지현" },
    });
    expect(speakersOf(r)).toEqual(["1", "2", "2.1"]);
    expect(peopleIn(r)).toBe(2);
  });

  test("a recording is as long as its takes, or its words while a take is open", () => {
    expect(recordingMs(recording())).toBe(60_000);
    expect(
      recordingMs(
        recording({
          takes: [
            { file: "recordings/rmhz00cc0abcd-1.webm", offsetMs: 0, seconds: 0, pass: "none" },
          ],
          lines: [line("1", 0, 4200, "a")],
        }),
      ),
    ).toBe(4200);
  });

  test("a second pass's voices take the names of the live voices they share the most time with", () => {
    const live = [line("1", 0, 5000, "a"), line("2", 5000, 9000, "b"), line("1", 9000, 12000, "c")];
    const next = [line("A", 0, 4800, "a"), line("B", 4800, 9100, "b"), line("A", 9100, 12000, "c")];
    expect(carryNames(live, { "1": "지현", "2": "민수" }, next)).toEqual({ A: "지현", B: "민수" });
    // An unnamed live voice gives no name.
    expect(carryNames(live, { "1": "지현" }, next)).toEqual({ A: "지현" });
  });

  test("a take's second pass replaces its lines, moved to the take's place, and keeps the others", () => {
    const r = recording({
      takes: [
        { file: "recordings/rmhz00cc0abcd-1.webm", offsetMs: 0, seconds: 10, pass: "pending" },
        { file: "recordings/rmhz00cc0abcd-2.webm", offsetMs: 10_000, seconds: 10, pass: "none" },
      ],
      speakers: { "1": "지현", "2.1": "민수" },
      lines: [line("1", 0, 4000, "안녕 하세요"), line("2.1", 11_000, 13_000, "네")],
    });
    const next = withSecondPass(r, 0, [
      { speaker: "3", startMs: 0, endMs: 4100, text: " 안녕하세요 " },
      { speaker: "4", startMs: 4100, endMs: 6000, text: "반가워요" },
      { speaker: "4", startMs: 6000, endMs: 6000, text: "  " },
    ]);
    expect(next.lines).toEqual([
      line("3", 0, 4100, "안녕하세요"),
      line("4", 4100, 6000, "반가워요"),
      line("2.1", 11_000, 13_000, "네"),
    ]);
    expect(next.speakers).toEqual({ "2.1": "민수", "3": "지현" });

    const second = withSecondPass(next, 1, [
      { speaker: "1", startMs: 900, endMs: 3100, text: "네" },
    ]);
    expect(second.lines.at(-1)).toEqual(line("2.1", 10_900, 13_100, "네"));
    expect(second.speakers).toEqual({ "2.1": "민수", "3": "지현" });
  });

  test("runs a voice's adjacent lines together, with a space except between CJK characters", () => {
    expect(
      joinedLines([
        line("1", 0, 1000, "회의를"),
        line("1", 1500, 2000, "시작합니다"),
        line("2", 2100, 3000, "네"),
        line("2", 9000, 9500, "다음"),
      ]),
    ).toEqual([
      line("1", 0, 2000, "회의를 시작합니다"),
      line("2", 2100, 3000, "네"),
      line("2", 9000, 9500, "다음"),
    ]);
    expect(joinedLines([line("1", 0, 1, "会議"), line("1", 1, 2, "です")])[0]?.text).toBe(
      "会議です",
    );
  });

  test("reads as Markdown for agents: a voice and a time to a line", () => {
    const r = recording({
      speakers: { "1": "지현" },
      lines: [line("1", 3000, 4000, "시작할게요"), line("2", 65_000, 66_000, "네")],
    });
    expect(transcriptMarkdown({ version: 1, recordings: [r] }, "주간 회의")).toBe(
      "# Transcript: 주간 회의\n\n## Recording 2026-11-14 20:30 (1:06)\n\n" +
        "[0:03] 지현: 시작할게요\n[1:05] Speaker 2: 네\n",
    );
    expect(clockOf(3_723_000)).toBe("1:02:03");
  });

  test("the schema takes what is written and refuses a take file outside recordings/", () => {
    const file = { version: 1, recordings: [recording()] };
    expect(TranscriptFileSchema.safeParse(file).success).toBe(true);
    const bad = {
      version: 1,
      recordings: [
        recording({ takes: [{ file: "note.json", offsetMs: 0, seconds: 0, pass: "none" }] }),
      ],
    };
    expect(TranscriptFileSchema.safeParse(bad).success).toBe(false);
  });
});
