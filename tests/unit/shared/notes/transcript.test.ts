import { describe, expect, test } from "bun:test";
import {
  asksSpeakerCount,
  carryNames,
  clockOf,
  joinedLines,
  movedLines,
  newSpeakerKey,
  numberSpeakers,
  peopleIn,
  recordingMs,
  type SpeakerMoveScope,
  shouldPromptSpeakerCount,
  speakerKey,
  speakerName,
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
  test.each([
    [[25_000, 30_000], {}, false],
    [[400, 25_000, 30_000], {}, true],
    [[22_300, 49_800, 608_600, 854_800], {}, true],
    [[10_000, 10_000, 10_000, 10_000], {}, false],
    [[10_000, 10_000, 10_000, 10_000, 10_000], {}, true],
    [Array.from({ length: 8 }, () => 500), { participantCount: "7+" }, false],
    [Array.from({ length: 9 }, () => 500), { participantCount: "7+" }, true],
    [[400, 25_000, 30_000], { participantCount: 3 }, false],
    [[400, 25_000, 30_000], { speakerPromptDismissed: true }, false],
    [[400, 25_000, 30_000], { audioRemoved: true }, false],
  ] satisfies [
    number[],
    Partial<TranscriptRecording>,
    boolean,
  ][])("prompts only when the grouping may be fragmented (%j, %j)", (durations, options, expected) => {
    const rec = recording({
      ...options,
      lines: durations.map((ms, i) => line(String(i + 1), 0, ms, "a")),
    });
    expect(shouldPromptSpeakerCount(rec)).toBe(expected);
  });

  test("asks for the speaker count only with voice prints, audio and speech", () => {
    const split = recording({
      lines: [400, 25_000, 30_000].map((ms, i) => line(String(i + 1), 0, ms, "a")),
    });
    expect(asksSpeakerCount(split, true)).toBe(true);
    expect(asksSpeakerCount(split, false)).toBe(false);
    expect(asksSpeakerCount({ ...split, takes: [] }, true)).toBe(false);
    expect(asksSpeakerCount({ ...split, lines: [] }, true)).toBe(false);
  });

  test("compacts display numbers by first speech while keeping names and pinned keys", () => {
    const old = recording({
      speakers: { "7": "Alex" },
      lines: [
        line("5", 0, 1000, "a"),
        { ...line("7", 1000, 2000, "b"), pinned: true },
        line("1", 2000, 3000, "c"),
      ],
    });
    const next = numberSpeakers(old);
    expect(next.speakerNumbers).toEqual({ "5": "1", "7": "2", "1": "3" });
    expect(next.lines).toBe(old.lines);
    expect(next.speakers).toBe(old.speakers);
    expect(["5", "7", "1"].map((key) => speakerName(next, key))).toEqual([
      "Speaker 1",
      "Alex",
      "Speaker 3",
    ]);
  });

  test("keys a voice by its take, and names a take's file", () => {
    expect(speakerKey(0, "1")).toBe("1");
    expect(speakerKey(1, "1")).toBe("2.1");
    expect(takeFile("rmhz00cc0abcd", 0)).toBe("recordings/rmhz00cc0abcd-1.webm");
    expect(TAKE_FILE_RE.test(takeFile("rmhz00cc0abcd", 2))).toBe(true);
    expect(TAKE_FILE_RE.test("recordings/../note.json")).toBe(false);
  });

  test.each([
    ["auto", 3],
    ["7+", 3],
    [2, 2],
  ] as const)("applies participant selection %s when a take has only second-pass labels", (participantCount, count) => {
    const old = recording({ voicePrint: true, participantCount, lines: [] });
    const next = withSecondPass(old, 0, [
      line("a", 0, 1000, "a"),
      line("b", 1000, 2000, "b"),
      line("c", 2000, 3000, "c"),
    ]);
    expect(peopleIn(next)).toBe(count);
    expect(
      TranscriptFileSchema.parse({ version: 1, recordings: [next] }).recordings[0]
        ?.participantCount,
    ).toBe(participantCount);
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
    expect(carryNames(live, { "1": "지현" }, next)).toEqual({ A: "지현" });
  });

  test("a live voice's name goes to the one new voice that shares the most with it", () => {
    const live = [line("1", 0, 9000, "a"), line("2", 9000, 12000, "b")];
    const next = [line("A", 0, 6000, "a"), line("C", 6000, 9000, "x"), line("B", 9000, 12000, "b")];
    expect(carryNames(live, { "1": "지현", "2": "민수" }, next)).toEqual({ A: "지현", B: "민수" });
  });

  test("live voices the user named alike are one person, whose name goes to one new voice", () => {
    const twice = [line("1", 0, 5000, "a"), line("2", 5000, 9000, "b")];
    const split = [line("A", 0, 5000, "a"), line("B", 5000, 9000, "b")];
    expect(carryNames(twice, { "1": "지현", "2": "지현" }, split)).toEqual({ A: "지현" });
    const mixed = [
      line("1", 0, 4000, "a"),
      line("2", 4000, 6000, "b"),
      line("3", 6000, 12000, "c"),
    ];
    const heard = [line("A", 0, 4000, "a"), line("B", 4000, 12000, "b")];
    const names = { "1": "지현", "2": "민수", "3": "지현" };
    expect(carryNames(mixed, names, heard)).toEqual({ B: "지현" });
    expect(carryNames(mixed, names, [line("A", 0, 12000, "a")])).toEqual({ A: "지현" });
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

  test("a recording told apart by voice print keeps its voices through the second pass", () => {
    const r = recording({
      voicePrint: true,
      takes: [
        { file: "recordings/rmhz00cc0abcd-1.webm", offsetMs: 0, seconds: 10, pass: "pending" },
        { file: "recordings/rmhz00cc0abcd-2.webm", offsetMs: 10_000, seconds: 10, pass: "pending" },
      ],
      speakers: { "1": "지현", "2": "민수" },
      lines: [
        line("1", 0, 3000, "안녕 하세요"),
        { ...line("2", 3200, 6000, "반가 워요"), pinned: true },
        line("3", 6500, 9000, "네 그래요"),
        line("1", 11_000, 13_000, "다음"),
      ],
    });
    const next = withSecondPass(r, 0, [
      { speaker: "1", startMs: 0, endMs: 3100, text: "안녕하세요" },
      { speaker: "1", startMs: 3100, endMs: 6100, text: "반가워요" },
      { speaker: "1", startMs: 6400, endMs: 9100, text: "네, 그래요" },
    ]);
    expect(next.lines).toEqual([
      line("1", 0, 3100, "안녕하세요"),
      { ...line("2", 3100, 6100, "반가워요"), pinned: true },
      line("3", 6400, 9100, "네, 그래요"),
      line("1", 11_000, 13_000, "다음"),
    ]);
    expect(next.speakers).toEqual({ "1": "지현", "2": "민수" });
    const second = withSecondPass(next, 1, [
      { speaker: "2", startMs: 900, endMs: 3100, text: "다음에" },
    ]);
    expect(second.lines.at(-1)).toEqual(line("1", 10_900, 13_100, "다음에"));
    expect(second.lines).toHaveLength(4);
  });

  test("moves a shown line's lines to another voice, and keeps them there", () => {
    const r = recording({
      speakers: { "1": "지현" },
      lines: [line("1", 0, 1000, "가"), line("1", 1500, 2500, "나"), line("1", 9000, 9500, "다")],
    });
    const [shown] = joinedLines(r.lines);
    const moved = movedLines(r, shown as TranscriptRecording["lines"][number], "2");
    expect(moved.lines).toEqual([
      { ...line("2", 0, 1000, "가"), pinned: true },
      { ...line("2", 1500, 2500, "나"), pinned: true },
      line("1", 9000, 9500, "다"),
    ]);
    expect(newSpeakerKey(moved)).toBe("3");
    expect(newSpeakerKey(recording({ speakers: { "1": "지현" } }))).toBe("2");
  });

  test.each([
    ["line", [2, 3]],
    ["following", [2, 3, 4, 6]],
    ["all", [0, 2, 3, 4, 6]],
  ] satisfies [
    SpeakerMoveScope,
    number[],
  ][])("moves only the selected person's lines for scope %s", (scope, changed) => {
    const r = recording({
      participantCount: 2,
      speakers: { "1": "Alex", "4": "Alex", "2": "Pat" },
      lines: [
        line("1", 0, 1000, "a"),
        line("2", 1500, 2000, "b"),
        line("1", 3000, 4000, "c"),
        line("1", 4500, 5000, "d"),
        line("4", 5200, 6000, "e"),
        line("2", 6200, 6700, "f"),
        line("1", 7500, 8000, "g"),
      ],
    });
    const shown = joinedLines(r.lines)[2] as TranscriptRecording["lines"][number];
    const moved = movedLines(r, shown, "2", scope);
    expect(moved.lines).toEqual(
      r.lines.map((l, i) => (changed.includes(i) ? { ...l, speaker: "2", pinned: true } : l)),
    );
    expect(moved.speakers).toEqual(scope === "all" ? { "2": "Pat" } : r.speakers);
    expect(moved.participantCount).toBe(2);
  });

  test("transfers a merged name to an unnamed target and preserves cross-take pins through a second pass", () => {
    const r = numberSpeakers(
      recording({
        takes: [
          { file: "recordings/rmhz00cc0abcd-1.webm", pass: "none", offsetMs: 0, seconds: 10 },
          {
            file: "recordings/rmhz00cc0abcd-2.webm",
            pass: "pending",
            offsetMs: 10_000,
            seconds: 10,
          },
        ],
        speakers: { "2.1": "Alex" },
        lines: [
          line("1", 0, 1000, "a"),
          line("2.1", 10_100, 10_500, "b"),
          line("2.2", 10_600, 12_000, "c"),
        ],
      }),
    );
    const merged = movedLines(r, r.lines[1] as TranscriptRecording["lines"][number], "1", "all");
    expect(merged.speakers).toEqual({ "1": "Alex" });
    expect(merged.lines[1]).toEqual({ ...r.lines[1], speaker: "1", pinned: true });
    expect(merged.speakerNumbers).toEqual({ "1": "1", "2.2": "2" });
    const next = withSecondPass(merged, 1, [
      line("2", 0, 1200, "better b"),
      line("2", 1200, 2000, "better c"),
    ]);
    expect(next.lines).toEqual([
      r.lines[0],
      { ...line("1", 10_000, 11_200, "better b"), pinned: true },
      line("2.2", 11_200, 12_000, "better c"),
    ]);
    expect(next.speakers).toEqual({ "1": "Alex" });
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

test.each([
  false,
  true,
])("keeps live lines when a second pass has no usable text (voicePrint: %p)", (voicePrint) => {
  const live = recording({ voicePrint, lines: [line("1", 0, 5000, "Live transcript")] });
  expect(withSecondPass(live, 0, [])).toBe(live);
  expect(withSecondPass(live, 0, [line("1", 0, 5000, "   ")])).toBe(live);
});

test.each([
  false,
  true,
])("ignores a sliver of overlap with a manual assignment (voicePrint: %p)", (voicePrint) => {
  const live = recording({
    voicePrint,
    speakers: { "1": "Alex", "2": "Pat" },
    lines: [
      { ...line("1", 0, 500, "Yes"), pinned: true },
      line("2", 500, 6000, "The rest of the sentence"),
    ],
  });
  const merged = withSecondPass(live, 0, [
    line("2", 10, 440, "Yes"),
    line("2", 450, 6000, "The rest of the sentence"),
  ]);
  expect(merged.lines).toEqual([
    { ...line("1", 10, 440, "Yes"), pinned: true },
    line("2", 450, 6000, "The rest of the sentence"),
  ]);
});
