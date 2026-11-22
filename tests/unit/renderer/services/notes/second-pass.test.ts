import { expect, mock, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { runSecondPass } from "../../../../../src/renderer/services/notes/second-pass";
import {
  dropTranscript,
  loadTranscript,
} from "../../../../../src/renderer/services/notes/transcripts";
import { useNoteSummarySettings } from "../../../../../src/renderer/state/stores/note-summary";
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

const longLines = [0, 10_000, 20_000].map((startMs) => ({
  ...line,
  startMs,
  endMs: startMs + 10_000,
}));

test("automatically summarizes a resumed pass only after its refined transcript is saved", async () => {
  const savedWindow = globalThis.window;
  const previousSettings = useNoteSummarySettings.getState();
  const polled = Promise.withResolvers<void>();
  const pass = Promise.withResolvers<unknown>();
  const writing = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<void>();
  globalThis.window = {
    ipc: {
      async call(_channel: string, method: string) {
        if (method === "voiceTranscription") {
          polled.resolve();
          return pass.promise;
        }
      },
    },
  } as unknown as typeof window;
  useNoteSummarySettings.setState({ enabled: true });
  const read = spyOn(notesApi, "readTranscript").mockResolvedValue({
    version: 1,
    recordings: [{ ...recording, takes: [{ ...recording.takes[0], seconds: 30 }] }],
  });
  const save = spyOn(notesApi, "saveTranscript").mockImplementation(async (_ws, _id, edits) => {
    expect(edits[0]?.after?.takes[0]?.pass).toBe("done");
    expect(edits[0]?.after?.lines.map(({ text }) => text)).toEqual(["First", "Second", "Third"]);
    writing.resolve();
    await saved.promise;
  });
  const summarize = spyOn(notesApi, "summarize").mockResolvedValue(null);
  const run = runSecondPass(workspaceId, noteId, recording.id);
  try {
    await polled.promise;
    expect(summarize).not.toHaveBeenCalled();
    pass.resolve({
      status: "done",
      id: "job",
      seconds: 30,
      segments: longLines.map((segment, index) => ({
        ...segment,
        text: ["First", "Second", "Third"][index],
      })),
    });
    await writing.promise;
    expect(summarize).not.toHaveBeenCalled();
    saved.resolve();
    await run;
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(workspaceId, noteId, recording.id, "auto");
  } finally {
    pass.resolve(null);
    saved.resolve();
    await run;
    summarize.mockRestore();
    save.mockRestore();
    read.mockRestore();
    useNoteSummarySettings.setState(previousSettings, true);
    globalThis.window = savedWindow;
    dropTranscript(workspaceId, noteId);
  }
});

test.each([
  [true, 30_000, 3, 1],
  [true, 29_999, 3, 0],
  [true, 30_000, 2, 0],
  [false, 30_000, 3, 0],
] as const)("without a second pass (enabled=%s, ms=%i, rows=%i), requests %i automatic summaries", async (enabled, ms, rows, expected) => {
  const previousSettings = useNoteSummarySettings.getState();
  useNoteSummarySettings.setState({ enabled });
  const read = spyOn(notesApi, "readTranscript").mockResolvedValue({
    version: 1,
    recordings: [
      {
        ...recording,
        lines: longLines.map((segment, index) => ({
          ...segment,
          endMs: Math.min(segment.endMs, ms),
          text: index < rows ? segment.text : " ",
        })),
        takes: [
          {
            ...recording.takes[0],
            seconds: ms / 1000,
            pass: "none",
            transcriptionId: undefined,
            token: "for-refinement",
          },
        ],
      },
    ],
  });
  const summarize = spyOn(notesApi, "summarize").mockResolvedValue(null);
  try {
    await runSecondPass(workspaceId, noteId, recording.id, false);
    expect(summarize).toHaveBeenCalledTimes(expected);
  } finally {
    summarize.mockRestore();
    read.mockRestore();
    useNoteSummarySettings.setState(previousSettings, true);
    dropTranscript(workspaceId, noteId);
  }
});
