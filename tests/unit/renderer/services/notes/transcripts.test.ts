import { expect, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  dropTranscript,
  flushTranscript,
  loadTranscript,
  nameSpeaker,
  transcriptKey,
  updateTranscript,
} from "../../../../../src/renderer/services/notes/transcripts";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

test("a task and its parent edit the same cached transcript", async () => {
  const parent = crypto.randomUUID();
  const task = crypto.randomUUID();
  const workspaces = useWorkspacesStore.getState().workspaces;
  const workspace = { name: "notes", rootPath: "/notes", pinned: false, tabs: [] };
  useWorkspacesStore.setState({
    workspaces: [
      WorkspaceMetaSchema.parse({ ...workspace, id: parent }),
      WorkspaceMetaSchema.parse({
        ...workspace,
        id: task,
        rootPath: "/notes-task",
        task: { parentId: parent, branch: "notes-task", worktreePath: "/notes-task" },
      }),
    ],
  });
  const recording: TranscriptRecording = {
    id: "rmhz00cc0abcd",
    startedAt: 1,
    language: "en",
    takes: [],
    speakers: {},
    lines: [{ speaker: "1", startMs: 0, endMs: 4000, text: "Existing transcript" }],
  };
  const added = { ...recording, id: "rmhz00cc0abce" };
  const read = spyOn(notesApi, "readTranscript").mockResolvedValue({
    version: 1,
    recordings: [recording],
  });
  const save = spyOn(notesApi, "saveTranscript").mockResolvedValue();
  try {
    await loadTranscript(task, "note");
    await loadTranscript(parent, "note");
    expect(read).toHaveBeenCalledTimes(1);
    expect(transcriptKey(task, "note")).toBe(transcriptKey(parent, "note"));
    updateTranscript(parent, "note", (file) => ({
      ...file,
      recordings: [...file.recordings, added],
    }));
    await flushTranscript(parent, "note");
    nameSpeaker(task, "note", recording.id, "1", "Pat");
    await flushTranscript(task, "note");

    expect((await loadTranscript(parent, "note")).recordings.map(({ id }) => id)).toEqual([
      recording.id,
      added.id,
    ]);
    expect(save).toHaveBeenLastCalledWith(
      task,
      "note",
      [
        expect.objectContaining({
          id: recording.id,
          after: expect.objectContaining({ speakers: { "1": "Pat" } }),
        }),
      ],
      false,
    );
  } finally {
    read.mockRestore();
    save.mockRestore();
    dropTranscript(task, "note");
    useWorkspacesStore.setState({ workspaces });
  }
});
