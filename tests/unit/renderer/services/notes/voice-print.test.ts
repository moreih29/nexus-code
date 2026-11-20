import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  type HeardLine,
  VOICE_PRINT_RATE,
  VoiceTracker,
} from "../../../../../src/renderer/services/notes/voice-print";

/** Audio of person `who` (1 to 4) talking for `seconds`: the fake model knows them by level. */
function speech(who: number, seconds: number): Float32Array {
  return new Float32Array(VOICE_PRINT_RATE * seconds).fill(who / 10);
}

const original = notesApi.voicePrint;
const asked: number[] = [];

afterAll(() => {
  notesApi.voicePrint = original;
});

beforeEach(() => {
  asked.length = 0;
  notesApi.voicePrint = async (audio: Float32Array) => {
    asked.push(audio.length);
    const vector = [0, 0, 0, 0];
    vector[Math.round((audio[0] as number) * 10) - 1] = 1;
    return vector;
  };
});

describe("VoiceTracker", () => {
  // The recording's lines as the recorder keeps them: each one's voice, by start.
  let lines: Map<number, string>;
  let tracker: VoiceTracker;
  let takeStart: number;
  let heardMs: number;

  beforeEach(() => {
    lines = new Map();
    tracker = new VoiceTracker();
    tracker.startTake();
    takeStart = 0;
    heardMs = 0;
  });

  /** The keys known, as the recorder gives them: not those of lines still being heard. */
  const known = () => [...lines].filter(([at]) => !tracker.undecided(at)).map(([, k]) => k);

  /** `who` says a line of `seconds` under the server's `label`: the voice it ends up with. */
  async function say(who: number, seconds: number, label = "1"): Promise<string> {
    const startMs = heardMs;
    tracker.hear(speech(who, seconds));
    heardMs += seconds * 1000;
    const line: HeardLine = {
      at: takeStart + startMs,
      endAt: takeStart + heardMs,
      startMs,
      endMs: heardMs,
      label,
    };
    lines.set(line.at, tracker.provisional(label, known()));
    const { key, regrouped } = await tracker.lineHeard(line, known, () => ({}));
    for (const [at, k] of regrouped ?? []) if (lines.has(at)) lines.set(at, k);
    lines.set(line.at, key);
    return key;
  }

  test("tells voices the server heard as one apart, numbering them from 1", async () => {
    expect(await say(1, 4)).toBe("1");
    expect(await say(2, 4)).toBe("2");
    expect(await say(1, 4)).toBe("1");
    expect(await say(3, 5)).toBe("3");
    // The words under the server's label go with the voice heard last until known.
    expect(tracker.provisional("1", lines.values())).toBe("3");
  });

  test("numbers the first voice 1 when more lines come while it is still heard", async () => {
    // A long first line, and two more right after it, before the model has heard the first.
    const heard = [say(1, 22), say(1, 0.1), say(1, 9)];
    expect([...lines.values()]).toEqual(["1", "1", "1"]);
    expect(await Promise.all(heard)).toEqual(["1", "1", "1"]);
    expect(await say(2, 4)).toBe("2");
  });

  test("keeps the first number when its first usable voice print comes after a short line", async () => {
    expect(await say(1, 0.1)).toBe("1");
    expect(await say(1, 4)).toBe("1");
    expect(await say(2, 4)).toBe("2");
  });

  test("asks the model for at most 10 seconds of a line, and none for a short one", async () => {
    await say(1, 12);
    expect(asked).toEqual([VOICE_PRINT_RATE * 10]);
    // Too short for a voice print: it goes with its label's voice.
    expect(await say(2, 0.3)).toBe("1");
    expect(asked.length).toBe(1);
  });

  test("keeps the selected cap across periodic regrouping and takes", async () => {
    tracker = new VoiceTracker(2);
    tracker.startTake();
    expect(await say(1, 4)).toBe("1");
    expect(await say(2, 4)).toBe("2");
    await say(3, 9);
    tracker.startTake();
    takeStart = 20_000;
    heardMs = 0;
    await say(4, 4);
    expect(new Set(lines.values()).size).toBe(2);
    expect(new Set(tracker.regroup({}).values()).size).toBe(2);
  });

  test("moves only the line the user moved, and keeps it there", async () => {
    await say(1, 4);
    await say(2, 4);
    await say(1, 4);
    await say(2, 4);
    // The user says one of the second voice's lines is the first person's: only it moves.
    const keys = tracker.pin([4000], "1", {});
    expect([0, 4000, 8000, 12_000].map((at) => keys.get(at))).toEqual(["1", "1", "1", "2"]);
    for (const [at, k] of keys) lines.set(at, k);
    expect(await say(2, 4)).toBe("2");
    // To a new person: it stays there, and its voice's other lines where they were.
    const split = tracker.pin([16_000], "3", {});
    for (const [at, k] of split) lines.set(at, k);
    expect(split.get(16_000)).toBe("3");
    expect(split.get(12_000)).toBe("2");
  });

  test("starts the audio over with each take", async () => {
    await say(1, 4);
    await say(2, 4);
    // The next take's lines are timed in its own audio, and its labels are its own.
    tracker.startTake();
    takeStart = 60_000;
    heardMs = 0;
    expect(await say(2, 4, "1")).toBe("2");
    expect(await say(1, 4, "2")).toBe("1");
  });
});
