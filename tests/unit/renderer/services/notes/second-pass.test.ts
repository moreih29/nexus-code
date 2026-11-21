import { expect, mock, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { runSecondPass } from "../../../../../src/renderer/services/notes/second-pass";
import {
  dropTranscript,
  loadTranscript,
} from "../../../../../src/renderer/services/notes/transcripts";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";

const workspaceId = "second-pass";
const noteId = "notes";
const line = { speaker: "1", startMs: 0, endMs: 5000, text: "Live transcript" };
const recording: TranscriptRecording = {
  id: "rmhz00cc0abcd",
  startedAt: 0,
  language: "en",
  lines: [line],
  takes: [
    {
      file: "recordings/rmhz00cc0abcd-1.webm",
      seconds: 10,
      offsetMs: 0,
      pass: "pending",
      transcriptionId: "job",
    },
  ],
  speakers: {},
};

test("retains a second-pass job when saving fails and discards it only after a successful retry", async () => {
  const savedWindow = globalThis.window;
  const drop = mock(() => {});
  globalThis.window = {
    ipc: {
      async call(_channel: string, method: string) {
        if (method === "voiceTranscription") {
          return {
            status: "done",
            id: "job",
            seconds: 10,
            segments: [{ ...line, text: "Improved transcript" }],
          };
        }
        if (method === "voiceTranscriptionDrop") drop();
      },
    },
  } as unknown as typeof window;
  const read = spyOn(notesApi, "readTranscript").mockResolvedValue({
    version: 1,
    recordings: [recording],
  });
  const save = spyOn(notesApi, "saveTranscript")
    .mockRejectedValueOnce(new Error("disk write failed"))
    .mockImplementation(async (_workspaceId, _noteId, edits) => {
      expect(drop).not.toHaveBeenCalled();
      expect(edits[0]?.after).toMatchObject({
        takes: [{ pass: "done" }],
        lines: [{ text: "Improved transcript" }],
      });
    });
  try {
    await runSecondPass(workspaceId, noteId, recording.id);
    expect(drop).not.toHaveBeenCalled();
    expect((await loadTranscript(workspaceId, noteId)).recordings[0]).toMatchObject({
      takes: [{ pass: "pending", transcriptionId: "job" }],
      lines: [line],
    });

    await runSecondPass(workspaceId, noteId, recording.id);
    expect(drop).toHaveBeenCalledTimes(1);
    const completed = (await loadTranscript(workspaceId, noteId)).recordings[0];
    expect(completed?.takes[0]?.pass).toBe("done");
    expect(completed?.takes[0]?.transcriptionId).toBeUndefined();
  } finally {
    save.mockRestore();
    read.mockRestore();
    globalThis.window = savedWindow;
    dropTranscript(workspaceId, noteId);
  }
});

test("reports an empty second pass as an error while retaining the live transcript", async () => {
  const savedWindow = globalThis.window;
  globalThis.window = {
    ipc: {
      async call(_channel: string, method: string) {
        if (method === "voiceTranscription")
          return { status: "done", id: "job", seconds: 10, segments: [] };
      },
    },
  } as unknown as typeof window;
  const read = spyOn(notesApi, "readTranscript").mockResolvedValue({
    version: 1,
    recordings: [recording],
  });
  const save = spyOn(notesApi, "saveTranscript").mockResolvedValue();
  try {
    await runSecondPass(workspaceId, noteId, recording.id);
    expect((await loadTranscript(workspaceId, noteId)).recordings[0]).toMatchObject({
      takes: [{ pass: "error" }],
      lines: [line],
    });
  } finally {
    save.mockRestore();
    read.mockRestore();
    globalThis.window = savedWindow;
    dropTranscript(workspaceId, noteId);
  }
});
