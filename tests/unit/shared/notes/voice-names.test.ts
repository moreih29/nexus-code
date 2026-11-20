import { describe, expect, test } from "bun:test";
import {
  movedLines,
  TranscriptFileSchema,
  type TranscriptRecording,
  withRejectedVoiceName,
} from "../../../../src/shared/notes/transcript";
import {
  type RememberedVoice,
  suggestVoiceNames,
  VOICE_NAME_RECORDINGS,
  voiceNameCandidates,
  withRememberedVoice,
} from "../../../../src/shared/notes/voice-names";

const vector = (score: number) => [score, Math.sqrt(1 - score ** 2)];
const candidate = (key: string, score: number, rejected: string[] = []) => ({
  key,
  vector: vector(score),
  rejected,
});
const profiles = [{ name: "A", average: vector(1) }];

describe("remembered voice suggestions", () => {
  test.each([
    ["above cutoff", profiles, [candidate("1", 0.73)], [], [{ key: "1", name: "A" }]],
    ["below cutoff", profiles, [candidate("1", 0.71)], [], []],
    [
      "small margin",
      [...profiles, { name: "B", average: vector(0.98) }],
      [candidate("1", 1)],
      [],
      [],
    ],
    [
      "large margin",
      [...profiles, { name: "B", average: vector(0.9) }],
      [candidate("1", 1)],
      [],
      [{ key: "1", name: "A" }],
    ],
    [
      "highest match wins",
      profiles,
      [candidate("1", 0.91), candidate("2", 0.94)],
      [],
      [{ key: "2", name: "A" }],
    ],
    ["name in use", profiles, [candidate("2", 1)], ["A"], []],
    ["rejected name", profiles, [candidate("1", 1, ["A"])], [], []],
  ] as const)("%s", (_label, remembered, speakers, named, expected) => {
    expect(suggestVoiceNames(remembered, { speakers: [...speakers], named: [...named] })).toEqual([
      ...expected,
    ]);
  });

  test.each([
    ["short line excluded even when pinned", [3000, 3000, 2999], "", 0],
    ["too little speech", [3000, 3000], "", 0],
    ["enough speech", [3000, 3000, 3000], "", 1],
    ["short line does not skew the average", [3000, 3000, 3000, 2999], "", 1],
    ["named speaker excluded", [3000, 3000, 3000], "A", 0],
  ] as const)("%s", (_label, lengths, name, count) => {
    const lines = lengths.map((ms, index) => ({
      startMs: index * 4000,
      endMs: index * 4000 + ms,
      speaker: "1",
      pinned: true,
      text: "",
    }));
    const recording: TranscriptRecording = {
      id: "r0000000000",
      lines,
      speakers: name ? { "1": name } : {},
      takes: [],
      language: "en",
      startedAt: 0,
    };
    const candidates = voiceNameCandidates(
      recording,
      lines.map((line) => ({
        at: line.startMs,
        ms: line.endMs - line.startMs,
        key: "prior assignment",
        vector: vector(line.endMs - line.startMs === 3000 ? 1 : 0),
      })),
    );
    expect(candidates.speakers).toHaveLength(count);
    if (count) expect(candidates.speakers[0]?.vector).toEqual([1, 0]);
  });
});

const learn = (previous: RememberedVoice | undefined, number: number, score: number) =>
  withRememberedVoice(previous, {
    name: "A",
    recordingId: `r000000000${number}`,
    recordedAt: number,
    vector: vector(score),
  });

describe("learning remembered voices", () => {
  test.each([
    ["new person", undefined, 1, 1, 1],
    ["existing person", learn(undefined, 1, 1), 2, 0.95, 2],
    ["same recording replaced", learn(undefined, 1, 1), 1, 0.95, 1],
    ["dissimilar voice rejected", learn(undefined, 1, 1), 2, 0.6, undefined],
  ] as const)("%s", (_label, previous, number, score, count) => {
    expect(learn(previous, number, score)?.recordings.length).toBe(count);
  });

  test("keeps the newest five recordings and averages their unit vectors", () => {
    let profile = learn(undefined, 0, 1);
    for (let i = 1; i <= VOICE_NAME_RECORDINGS; i++) profile = learn(profile, i, 0.9);
    expect(profile?.recordings.map((r) => r.recordedAt)).toEqual([5, 4, 3, 2, 1]);
    expect(profile?.average[0]).toBeCloseTo(0.9);
    expect(profile?.average[1]).toBeCloseTo(Math.sqrt(1 - 0.9 ** 2));
    expect(learn(profile, 0, 0.9)?.recordings.map((r) => r.recordedAt)).toEqual([5, 4, 3, 2, 1]);
  });
});

test("a declined name survives a transcript round trip and a merge", () => {
  const lines = Array.from({ length: 3 }, (_, i) => ({
    startMs: i * 4000,
    endMs: i * 4000 + 3000,
    speaker: "1",
    text: "",
  }));
  const recording: TranscriptRecording = {
    id: "r0000000000",
    lines,
    speakers: {},
    takes: [],
    language: "en",
    startedAt: 0,
  };
  const original = withRejectedVoiceName(recording, "1", "A");
  const serialized = JSON.stringify(
    TranscriptFileSchema.parse({
      version: 1,
      recordings: [{ ...original, suggestions: [{ name: "A" }], vector: [1, 0] }],
    }),
  );
  expect(serialized).not.toContain("vector");
  expect(serialized).not.toContain("suggestions");
  const restored = TranscriptFileSchema.parse(JSON.parse(serialized)).recordings[0];
  if (!restored) throw new Error("Expected a recording");
  const prints = lines.map((l) => ({ at: l.startMs, ms: 3000, key: "1", vector: [1, 0] }));
  expect(restored.rejectedVoiceNames).toEqual({ "1": ["A"] });
  expect(suggestVoiceNames(profiles, voiceNameCandidates(restored, prints))).toEqual([]);
  const first = lines[0];
  if (!first) throw new Error("Expected a line");
  const merged = movedLines(restored, first, "2", "all");
  expect(merged.rejectedVoiceNames).toEqual({ "2": ["A"] });
  expect(suggestVoiceNames(profiles, voiceNameCandidates(merged, prints))).toEqual([]);
});
