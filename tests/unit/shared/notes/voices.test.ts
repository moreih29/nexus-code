import { describe, expect, test } from "bun:test";
import {
  GROUP_MIN_MS,
  liveVoice,
  NEW_VOICE_MS,
  nextVoiceKey,
  regroupVoices,
  type VoiceSample,
  voiceSums,
} from "../../../../src/shared/notes/voices";

function voice(axis: number, tilt = 0): number[] {
  const v = [0, 0, 0, 0];
  v[axis] = Math.cos(tilt);
  v[(axis + 1) % 4] = Math.sin(tilt);
  return v;
}

let at = 0;
function sample(axis: number, key: string, extra: Partial<VoiceSample> = {}): VoiceSample {
  at += 10_000;
  return { at, ms: 4000, vector: voice(axis, (at % 7) * 0.02), key, ...extra };
}

describe("voices", () => {
  test("takes the next number as a new voice's key", () => {
    expect(nextVoiceKey([])).toBe("1");
    expect(nextVoiceKey(["1", "3", "2.1"])).toBe("2");
  });

  test("gives a line as it comes the nearest voice, a new one, or the fallback", () => {
    const sums = voiceSums([sample(0, "1"), sample(0, "1"), sample(1, "2")]);
    expect(liveVoice(sums, { vector: voice(0), ms: 1000 }, ["1", "2"], null)).toBe("1");
    expect(liveVoice(sums, { vector: voice(2), ms: NEW_VOICE_MS }, ["1", "2"], "2")).toBe("3");
    expect(liveVoice(sums, { vector: voice(2), ms: 1000 }, ["1", "2"], "2")).toBe("2");
    expect(liveVoice(sums, { vector: null, ms: 500 }, ["1", "2"], "1")).toBe("1");
  });

  test.each([
    [undefined, "3"],
    [2, "1"],
    [3, "3"],
  ] as const)("uses the nearest live voice at the selected cap %s", (target, expected) => {
    const sums = voiceSums([sample(0, "1"), sample(1, "2")]);
    expect(
      liveVoice(
        sums,
        { vector: voice(0, 1.3).map((v, i) => (i === 1 ? 0 : v)), ms: 4000 },
        ["1", "2"],
        "2",
        target,
      ),
    ).toBe(expected);
  });

  test.each([
    [2, {}, 2],
    [3, {}, 3],
    [1, { "1": "A", "2": "B", "3": "C" }, 3],
  ] as const)("clusters to %i voices while preserving protected people", (target, names, count) => {
    const samples = [sample(0, "1"), sample(1, "2"), sample(2, "3")];
    const withoutVector = { at: (samples[0] as VoiceSample).at + 1, ms: 200, key: "4" };
    const short = sample(0, "5", { ms: 900 });
    const keys = regroupVoices({
      samples: [...samples, short],
      lines: [...samples, short, withoutVector],
      names,
      target,
    });
    expect(new Set(keys.values()).size).toBe(count);
    if (Object.keys(names).length)
      expect(samples.map((s) => keys.get(s.at))).toEqual(["1", "2", "3"]);
  });

  test("uses a protected slot for a pinned line without a voice print", () => {
    const samples = [sample(0, "1"), sample(1, "2")];
    const pinned = { at: 1, ms: 150, key: "3", pinned: true };
    const keys = regroupVoices({ samples, lines: [pinned, ...samples], names: {}, target: 2 });
    expect(keys.get(pinned.at)).toBe("3");
    expect(new Set(keys.values()).size).toBe(2);
  });

  test("groups lines whose voices are alike, keeping the key most of them had", () => {
    const samples = [
      sample(0, "1"),
      sample(0, "1"),
      sample(0, "1"),
      sample(0, "2"),
      sample(1, "2"),
      sample(1, "2"),
      sample(1, "1"),
      sample(1, "1"),
      sample(1, "2"),
    ];
    const keys = regroupVoices({ samples, names: {} });
    expect(samples.slice(0, 4).map((s) => keys.get(s.at))).toEqual(["1", "1", "1", "1"]);
    expect(samples.slice(4).map((s) => keys.get(s.at))).toEqual(["2", "2", "2", "2", "2"]);
  });

  test("tells a third voice apart under a key of its own", () => {
    const samples = [
      ...Array.from({ length: 4 }, () => sample(0, "1")),
      ...Array.from({ length: 4 }, () => sample(1, "2")),
      ...Array.from({ length: 4 }, () => sample(2, "2")),
    ];
    const keys = regroupVoices({ samples, names: {} });
    const third = new Set(samples.slice(8).map((s) => keys.get(s.at)));
    expect(third.size).toBe(1);
    expect([...third][0]).toBe("3");
    expect(samples.slice(4, 8).every((s) => keys.get(s.at) === "2")).toBe(true);
  });

  test("never groups lines the user moved to different people, and keeps them where moved", () => {
    const samples = [
      ...Array.from({ length: 4 }, () => sample(0, "1")),
      sample(1, "2", { pinned: true }),
      sample(1, "2"),
      sample(1, "3", { pinned: true }),
      sample(1, "3"),
    ];
    const keys = regroupVoices({ samples, names: {} });
    expect(keys.get((samples[4] as VoiceSample).at)).toBe("2");
    expect(keys.get((samples[6] as VoiceSample).at)).toBe("3");
    const named = regroupVoices({ samples, names: { "2": "지현", "3": "지현" } });
    expect(named.get((samples[4] as VoiceSample).at)).toBe("2");
    expect(named.get((samples[6] as VoiceSample).at)).toBe("3");
  });

  test("lets a few stray lines join the nearest voice, and short lines too", () => {
    const samples = [
      ...Array.from({ length: 5 }, () => sample(0, "1")),
      { at: 900_000, ms: 4000, vector: voice(0, 0.9), key: "4" },
      { at: 910_000, ms: GROUP_MIN_MS - 1, vector: voice(0, 0.2), key: "5" },
    ];
    const keys = regroupVoices({ samples, names: {} });
    expect(keys.get(900_000)).toBe("1");
    expect(keys.get(910_000)).toBe("1");
  });
});
