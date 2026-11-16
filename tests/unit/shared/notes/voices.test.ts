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

/** A unit vector near axis `axis` of four, tilted by `tilt` toward the next. */
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
    expect(nextVoiceKey(["1", "3", "2.1"])).toBe("4");
  });

  test("gives a line as it comes the nearest voice, a new one, or the fallback", () => {
    const sums = voiceSums([sample(0, "1"), sample(0, "1"), sample(1, "2")]);
    expect(liveVoice(sums, { vector: voice(0), ms: 1000 }, ["1", "2"], null)).toBe("1");
    // Unlike any: a new voice when long enough to tell, else the fallback.
    expect(liveVoice(sums, { vector: voice(2), ms: NEW_VOICE_MS }, ["1", "2"], "2")).toBe("3");
    expect(liveVoice(sums, { vector: voice(2), ms: 1000 }, ["1", "2"], "2")).toBe("2");
    expect(liveVoice(sums, { vector: null, ms: 500 }, ["1", "2"], "1")).toBe("1");
  });

  test("groups lines whose voices are alike, keeping the key most of them had", () => {
    // The live session put one of A's lines under B's key and two of B's under A's.
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
      // A third person the live session heard as the second.
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
      // Alike, but the user said these are two people.
      sample(1, "2", { pinned: true }),
      sample(1, "2"),
      sample(1, "3", { pinned: true }),
      sample(1, "3"),
    ];
    const keys = regroupVoices({ samples, names: {} });
    expect(keys.get((samples[4] as VoiceSample).at)).toBe("2");
    expect(keys.get((samples[6] as VoiceSample).at)).toBe("3");
    // Moved lines of voices given one name are one person, and may group.
    const named = regroupVoices({ samples, names: { "2": "지현", "3": "지현" } });
    expect(named.get((samples[4] as VoiceSample).at)).toBe("2");
    expect(named.get((samples[6] as VoiceSample).at)).toBe("3");
  });

  test("lets a few stray lines join the nearest voice, and short lines too", () => {
    const samples = [
      ...Array.from({ length: 5 }, () => sample(0, "1")),
      // One line heard a little off, under a voice of its own.
      { at: 900_000, ms: 4000, vector: voice(0, 0.9), key: "4" },
      // A short line, too short to group by.
      { at: 910_000, ms: GROUP_MIN_MS - 1, vector: voice(0, 0.2), key: "5" },
    ];
    const keys = regroupVoices({ samples, names: {} });
    expect(keys.get(900_000)).toBe("1");
    expect(keys.get(910_000)).toBe("1");
  });
});
