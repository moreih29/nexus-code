import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  dropRecording,
  pauseRecording,
  resumeRecording,
  startRecording,
  useRecorderStore,
} from "../../../../../src/renderer/services/notes/recorder";
import { useTranscriptsStore } from "../../../../../src/renderer/services/notes/transcripts";
import * as capture from "../../../../../src/renderer/services/voice/capture";
import { startNoteRemovalListener } from "../../../../../src/renderer/state/note-removal";
import { openOrRevealNoteTab } from "../../../../../src/renderer/state/operations/tabs";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import type { TranscriptFile } from "../../../../../src/shared/notes/transcript";
import {
  VOICE_CLOSE_SIGNED_OUT,
  type VoiceEvent,
  type VoiceStartResult,
} from "../../../../../src/shared/remote/voice";
import type { NoteChanged } from "../../../../../src/shared/types/notes";

const realWindow = globalThis.window;
let originalNotes: typeof notesApi;
const workspaceId = crypto.randomUUID();
const noteId = "recording-note";
const key = `${workspaceId}/${noteId}`;
const empty: TranscriptFile = { version: 1, recordings: [] };
const calls: string[] = [];
let voiceEvent: ((payload: VoiceEvent) => void) | undefined;
let startVoice: () => VoiceStartResult | Promise<VoiceStartResult>;
let noteChanged: ((payload: NoteChanged) => void) | undefined;
const ready: VoiceStartResult = {
  status: "ready",
  id: "voice-1",
  sampleRate: 24000,
  maxSeconds: 60,
};

beforeEach(() => {
  calls.length = 0;
  startVoice = () => ready;
  originalNotes = { ...notesApi };
  notesApi.readTranscript = async () => empty;
  notesApi.saveTranscript = async () => {};
  notesApi.voicePrint = async () => null;
  globalThis.window = {
    ipc: {
      async call(_channel: string, method: string) {
        calls.push(method);
        if (method === "account") return { status: "signed-in" };
        if (method === "serverInfo") return { voice: true };
        if (method === "voiceMicrophone") return "granted";
        if (method === "voiceStart") return startVoice();
      },
      listen(channel: string, name: string, listener: (payload: never) => void) {
        if (channel === "remote" && name === "voiceEvent")
          voiceEvent = listener as typeof voiceEvent;
        if (channel === "notes" && name === "changed") noteChanged = listener as typeof noteChanged;
        return () => {};
      },
    },
  } as unknown as typeof window;
});

afterEach(() => {
  dropRecording(workspaceId, noteId);
  const removeListener = startNoteRemovalListener();
  noteChanged?.({ change: "removed", locationKey: "local:/notes", workspaceIds: [workspaceId] });
  removeListener();
  Object.assign(notesApi, originalNotes);
  globalThis.window = realWindow;
});

function mockHardware() {
  const stopTrack = mock(() => {});
  const stopCapture = mock(() => {});
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const running = { level: () => 0, stop: stopCapture };
  const open = spyOn(capture, "openMicrophone").mockResolvedValue(stream);
  const start = spyOn(capture, "startCapture").mockResolvedValue(running);
  return {
    stopTrack,
    stopCapture,
    stream,
    running,
    open,
    start,
    restore() {
      open.mockRestore();
      start.mockRestore();
    },
  };
}

test("removing a notes location closes its tab and stops its active recorder", async () => {
  const hardware = mockHardware();
  const { tabId } = openOrRevealNoteTab(workspaceId, noteId);
  const unlisten = startNoteRemovalListener();
  try {
    await startRecording(workspaceId, noteId, "en");
    expect(useRecorderStore.getState().phase).toBe("recording");
    noteChanged?.({ change: "removed", locationKey: "local:/notes", workspaceIds: [workspaceId] });
    expect(useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]).toBeUndefined();
    expect(useRecorderStore.getState().phase).toBe("idle");
    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(hardware.stopCapture).toHaveBeenCalledTimes(1);
    expect(calls).toContain("voiceCancel");
    expect(useTranscriptsStore.getState().byNote[key]).toBeUndefined();
  } finally {
    unlisten();
    hardware.restore();
  }
});

test("stops a microphone acquired after its recording was dropped", async () => {
  const hardware = mockHardware();
  const entered = Promise.withResolvers<void>();
  const opening = Promise.withResolvers<MediaStream>();
  hardware.open.mockImplementationOnce(() => {
    entered.resolve();
    return opening.promise;
  });
  try {
    const starting = startRecording(workspaceId, noteId, "en");
    await entered.promise;
    dropRecording(workspaceId, noteId);
    opening.resolve(hardware.stream);
    await starting;

    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("voiceStart");
    expect(useRecorderStore.getState().phase).toBe("idle");
  } finally {
    hardware.restore();
  }
});

test("drops capture and its session when audio setup completes after deletion", async () => {
  const hardware = mockHardware();
  const entered = Promise.withResolvers<void>();
  const captureReady = Promise.withResolvers<capture.Capture>();
  hardware.start.mockImplementationOnce(() => {
    entered.resolve();
    return captureReady.promise;
  });
  try {
    const starting = startRecording(workspaceId, noteId, "en");
    await entered.promise;
    dropRecording(workspaceId, noteId);
    captureReady.resolve(hardware.running);
    await starting;

    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(hardware.stopCapture).toHaveBeenCalledTimes(1);
    expect(calls).toContain("voiceCancel");
    expect(useRecorderStore.getState().phase).toBe("idle");
  } finally {
    hardware.restore();
  }
});

test.each([
  "reply",
  "capture",
] as const)("does not start a recording when the voice socket closes before %s", async (before) => {
  const hardware = mockHardware();
  const close = () => {
    if (!voiceEvent) throw new Error("missing voice listener");
    voiceEvent({ id: ready.id, event: { t: "closed", code: 1006 } });
  };
  if (before === "reply")
    startVoice = () => {
      close();
      return ready;
    };
  else
    hardware.start.mockImplementationOnce(async () => {
      close();
      return hardware.running;
    });
  try {
    await startRecording(workspaceId, noteId, "en");
    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(hardware.start).toHaveBeenCalledTimes(before === "capture" ? 1 : 0);
    expect(hardware.stopCapture).toHaveBeenCalledTimes(before === "capture" ? 1 : 0);
    expect(useRecorderStore.getState().phase).toBe("idle");
  } finally {
    hardware.restore();
  }
});

test("pause releases the microphone and excludes waiting for the server from the next take", async () => {
  const hardware = mockHardware();
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  const paused = Promise.withResolvers<void>();
  const unsubscribe = useRecorderStore.subscribe((state) => {
    if (state.phase === "paused") paused.resolve();
  });
  try {
    await startRecording(workspaceId, noteId, "en");
    clock.mockReturnValue(15_000);
    pauseRecording();

    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(useRecorderStore.getState()).toMatchObject({
      phase: "pausing",
      baseMs: 5000,
      takeSince: null,
    });
    if (!voiceEvent) throw new Error("missing voice listener");
    clock.mockReturnValue(18_000);
    voiceEvent({ id: ready.id, event: { t: "done", seconds: 5 } });
    voiceEvent({ id: ready.id, event: { t: "closed", code: 1000 } });
    await paused.promise;
    await resumeRecording();

    expect(useTranscriptsStore.getState().byNote[key]?.recordings[0]?.takes).toMatchObject([
      { seconds: 5, offsetMs: 0 },
      { offsetMs: 5000 },
    ]);
  } finally {
    unsubscribe();
    clock.mockRestore();
    hardware.restore();
  }
});

test.each([
  false,
  true,
])("4001 finalizes the recording with next take queued=%p", async (chaining) => {
  const hardware = mockHardware();
  const idle = Promise.withResolvers<void>();
  const unsubscribe = useRecorderStore.subscribe((state) => {
    if (state.phase === "idle") idle.resolve();
  });
  try {
    await startRecording(workspaceId, noteId, "en");
    if (!voiceEvent) throw new Error("missing voice listener");
    voiceEvent({ id: ready.id, event: { t: "final", text: "one", speaker: "1" } });
    voiceEvent({ id: ready.id, event: { t: "final", text: "two", speaker: "2" } });
    if (chaining) {
      voiceEvent({ id: ready.id, event: { t: "limit", reason: "session" } });
      expect(useRecorderStore.getState().phase).toBe("starting");
    }
    voiceEvent({ id: ready.id, event: { t: "closed", code: VOICE_CLOSE_SIGNED_OUT } });
    await idle.promise;
    expect(hardware.stopTrack).toHaveBeenCalledTimes(1);
    expect(hardware.stopCapture).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call === "voiceStart")).toHaveLength(1);
    expect(calls).not.toContain("voiceTranscribe");
    const recording = useTranscriptsStore.getState().byNote[key]?.recordings[0];
    expect(recording?.takes).toHaveLength(1);
    expect(recording?.takes[0]?.token).toBeUndefined();
    expect(recording?.lines.map((line) => line.text)).toEqual(["one", "two"]);
  } finally {
    unsubscribe();
    hardware.restore();
  }
});
