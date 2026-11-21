import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  dropRecording,
  startRecording,
  useRecorderStore,
} from "../../../../../src/renderer/services/notes/recorder";
import { useTranscriptsStore } from "../../../../../src/renderer/services/notes/transcripts";
import * as capture from "../../../../../src/renderer/services/voice/capture";
import { startNoteRemovalListener } from "../../../../../src/renderer/state/note-removal";
import { openOrRevealNoteTab } from "../../../../../src/renderer/state/operations/tabs";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import type { TranscriptFile } from "../../../../../src/shared/notes/transcript";
import type { VoiceStartResult } from "../../../../../src/shared/remote/voice";
import type { NoteChanged } from "../../../../../src/shared/types/notes";

const realWindow = globalThis.window;
let originalNotes: typeof notesApi;
const workspaceId = crypto.randomUUID();
const noteId = "recording-note";
const key = `${workspaceId}/${noteId}`;
const empty: TranscriptFile = { version: 1, recordings: [] };
const calls: string[] = [];
let noteChanged: ((payload: NoteChanged) => void) | undefined;
const ready: VoiceStartResult = {
  status: "ready",
  id: "voice-1",
  sampleRate: 24000,
  maxSeconds: 60,
};

beforeEach(() => {
  calls.length = 0;
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
        if (method === "voiceStart") return ready;
      },
      listen(channel: string, name: string, listener: (payload: never) => void) {
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
