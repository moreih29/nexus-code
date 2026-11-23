import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ToastAction, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  dropRecording,
  moveLine,
  startRecording,
  useRecorderStore,
} from "../../../../../src/renderer/services/notes/recorder";
import { regroupRecording } from "../../../../../src/renderer/services/notes/regroup";
import {
  flushTranscript,
  updateRecording,
  useTranscriptsStore,
} from "../../../../../src/renderer/services/notes/transcripts";
import {
  type HeardLine,
  VOICE_PRINT_RATE,
  VoiceTracker,
} from "../../../../../src/renderer/services/notes/voice-print";
import { voiceAvailabilityNow } from "../../../../../src/renderer/services/voice/availability";
import * as capture from "../../../../../src/renderer/services/voice/capture";
import { peopleIn, type TranscriptRecording } from "../../../../../src/shared/notes/transcript";

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

  const known = () => [...lines].filter(([at]) => !tracker.undecided(at)).map(([, k]) => k);

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
    expect(tracker.provisional("1", lines.values())).toBe("3");
  });

  test("numbers the first voice 1 when more lines come while it is still heard", async () => {
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

  test("can assign a late speaker after a manual merge frees a live slot", async () => {
    tracker = new VoiceTracker(3);
    tracker.startTake();
    await say(1, 4);
    await say(2, 4);
    expect(await say(3, 4)).toBe("3");

    const keys = tracker.pin([8000], "2", { "2": "Alex" }, new Set(["3"]));
    for (const [at, key] of keys) lines.set(at, key);
    expect(new Set(lines.values())).toEqual(new Set(["1", "2"]));
    expect(await say(4, 4)).toBe("3");
  });

  test("moves only the line the user moved, and keeps it there", async () => {
    await say(1, 4);
    await say(2, 4);
    await say(1, 4);
    await say(2, 4);
    const keys = tracker.pin([4000], "1", {});
    expect([0, 4000, 8000, 12_000].map((at) => keys.get(at))).toEqual(["1", "1", "1", "2"]);
    for (const [at, k] of keys) lines.set(at, k);
    expect(await say(2, 4)).toBe("2");
    const split = tracker.pin([16_000], "3", {});
    for (const [at, k] of split) lines.set(at, k);
    expect(split.get(16_000)).toBe("3");
    expect(split.get(12_000)).toBe("2");
  });

  test("keeps a merged assignment made while its voice print is pending", async () => {
    tracker = new VoiceTracker(2);
    tracker.startTake();
    await say(1, 4);
    const pending = say(2, 4);
    tracker.pin([4000], "3", {}, new Set(["2"]));
    expect(await pending).toBe("3");
    expect(tracker.regroup({}).get(4000)).toBe("3");
    expect(tracker.provisional("1", lines.values())).toBe("3");
  });

  test("starts the audio over with each take", async () => {
    await say(1, 4);
    await say(2, 4);
    tracker.startTake();
    takeStart = 60_000;
    heardMs = 0;
    expect(await say(2, 4, "1")).toBe("2");
    expect(await say(1, 4, "2")).toBe("1");
  });
});

test.each([
  "all",
  "line",
] as const)("reduces the participant count for a finished recording only (scope %s)", async (scope) => {
  const workspaceId = "test";
  const noteId = "speaker-edits";
  const key = `${workspaceId}/${noteId}`;
  const globals = globalThis as { window?: unknown };
  const previousWindow = globals.window;
  const previousState = useTranscriptsStore.getState();
  const open = spyOn(capture, "openMicrophone").mockResolvedValue({
    getTracks: () => [],
  } as unknown as MediaStream);
  const start = spyOn(capture, "startCapture").mockResolvedValue({ level: () => 0, stop() {} });
  const shown = { speaker: "3", startMs: 4000, endMs: 5000, text: "c" };
  const completed: TranscriptRecording = {
    id: "rmhz00cc0abcd",
    startedAt: 0,
    language: "en",
    participantCount: 3,
    takes: [],
    speakers: {},
    lines: [
      { speaker: "1", startMs: 0, endMs: 1000, text: "a" },
      { speaker: "2", startMs: 2000, endMs: 3000, text: "b" },
      shown,
    ],
  };
  const current = (id: string) =>
    useTranscriptsStore.getState().byNote[key]?.recordings.find((r) => r.id === id);
  try {
    globals.window = {
      ipc: {
        async call(_channel: string, method: string) {
          if (method === "account") return { status: "signed-in" };
          if (method === "serverInfo") return { voice: true };
          if (method === "voiceMicrophone") return "granted";
          if (method === "voiceStart")
            return { status: "started", id: "test", sampleRate: VOICE_PRINT_RATE };
        },
        listen: () => () => {},
      },
    };
    useTranscriptsStore.setState({ byNote: { [key]: { version: 1, recordings: [completed] } } });
    await voiceAvailabilityNow();
    await startRecording(workspaceId, noteId, "en", 3);
    const { phase, recordingId } = useRecorderStore.getState();
    expect(phase).toBe("recording");
    if (!recordingId) throw new Error("No active recording");
    updateRecording(workspaceId, noteId, recordingId, (r) => ({ ...r, lines: completed.lines }));

    moveLine(workspaceId, noteId, recordingId, shown, "2", scope);
    moveLine(workspaceId, noteId, completed.id, shown, "2", scope);
    for (const [id, count] of [
      [recordingId, 3],
      [completed.id, 2],
    ] as const) {
      const edited = current(id);
      expect(edited?.lines.at(-1)).toEqual({ ...shown, speaker: "2", pinned: true });
      expect(edited?.participantCount).toBe(count);
    }
  } finally {
    dropRecording(workspaceId, noteId);
    await flushTranscript(workspaceId, noteId);
    globals.window = previousWindow;
    useTranscriptsStore.setState(previousState);
    open.mockRestore();
    start.mockRestore();
  }
});

test.each([
  false,
  true,
])("regrouping restores the previous recording unless it was edited (%p)", async (edited) => {
  const previousState = useTranscriptsStore.getState();
  const previousContext = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
  const { readAsset, saveTranscript } = notesApi;
  const recording: TranscriptRecording = {
    id: "rmhz00cc0abcd",
    startedAt: 0,
    language: "en",
    participantCount: "auto",
    takes: [{ file: "recordings/rmhz00cc0abcd-1.webm", pass: "done", offsetMs: 0, seconds: 12 }],
    speakers: { "7": "Alex" },
    lines: [
      { speaker: "7", startMs: 0, endMs: 4000, text: "a", pinned: true },
      { speaker: "9", startMs: 4000, endMs: 8000, text: "b" },
      { speaker: "2", startMs: 8000, endMs: 12_000, text: "c" },
    ],
  };
  const pcm = new Float32Array(VOICE_PRINT_RATE * 12);
  pcm.set(speech(1, 4));
  pcm.set(speech(2, 4), VOICE_PRINT_RATE * 4);
  pcm.set(speech(1, 4), VOICE_PRINT_RATE * 8);
  class Decoder {
    async decodeAudioData() {
      return { length: pcm.length, numberOfChannels: 1, getChannelData: () => pcm };
    }
  }
  const current = () => useTranscriptsStore.getState().byNote["test/note"]?.recordings[0];
  let undo: ToastAction | undefined;
  const stopWatching = watchToasts((toast) => {
    undo = toast.actions?.[0] ?? undo;
  });
  try {
    Object.defineProperty(globalThis, "OfflineAudioContext", {
      configurable: true,
      value: Decoder,
    });
    notesApi.readAsset = async () => ({ base64: "AA==", mime: "audio/webm" });
    notesApi.saveTranscript = async () => {};
    useTranscriptsStore.setState({
      byNote: { "test/note": { version: 1, recordings: [recording] } },
    });
    await regroupRecording("test", "note", recording.id, 2);
    const grouped = current();
    expect(grouped?.participantCount).toBe(2);
    expect(grouped && peopleIn(grouped)).toBe(2);
    expect(grouped?.lines[0]).toBe(recording.lines[0]);
    expect(asked.filter((size) => size === VOICE_PRINT_RATE * 4)).toHaveLength(3);
    if (edited)
      updateRecording("test", "note", recording.id, (r) => ({ ...r, speakers: { "7": "Pat" } }));
    expect(undo).toBeDefined();
    undo?.onAction();
    if (edited) expect(current()?.speakers["7"]).toBe("Pat");
    else expect(current()).toBe(recording);
  } finally {
    await flushTranscript("test", "note");
    useTranscriptsStore.setState(previousState);
    notesApi.readAsset = readAsset;
    notesApi.saveTranscript = saveTranscript;
    if (previousContext) Object.defineProperty(globalThis, "OfflineAudioContext", previousContext);
    else Reflect.deleteProperty(globalThis, "OfflineAudioContext");
    stopWatching();
  }
});
