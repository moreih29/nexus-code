import { useEffect, useState } from "react";
import type { RecordingSummary } from "../../../shared/notes/summary";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { notesApi } from "./api";
import { noteLocation } from "./conversation";
import { flushTranscript } from "./transcripts";

export type RecordingSummaries = Readonly<Record<string, RecordingSummary>>;
const EMPTY: RecordingSummaries = {};

export function useNoteSummaries(
  workspaceId: string,
  noteId: string,
  tabId: string,
  visible: boolean,
): RecordingSummaries {
  const location = useWorkspacesStore(({ workspaces }) => {
    const workspace = workspaces.find(({ id }) => id === workspaceId);
    return workspace && noteLocation(workspace, workspaces);
  });
  const [saved, setSaved] = useState<{
    noteId: string;
    location: string;
    states: RecordingSummaries;
  }>();
  useEffect(() => {
    if (!location || !visible) return;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void notesApi.summaries(workspaceId, noteId).then(
        (states) => {
          if (request === revision) setSaved({ noteId, location, states });
        },
        () => {},
      );
    };
    const stop = notesApi.onSummaryChanged((event) => {
      if (event.noteId === noteId && event.locationKey === location) read();
    });
    read();
    void notesApi.summaryVisibility(workspaceId, noteId, tabId, true).catch(() => {});
    return () => {
      revision++;
      stop();
      void notesApi.summaryVisibility(workspaceId, noteId, tabId, false).catch(() => {});
    };
  }, [workspaceId, noteId, tabId, location, visible]);
  return saved?.noteId === noteId && saved.location === location ? saved.states : EMPTY;
}

/** Main reads the transcript from disk, so send edits made here before a manual request. */
export async function summarizeSavedRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  mode: "retry" | "rerun",
) {
  await flushTranscript(workspaceId, noteId, false, true);
  return notesApi.summarize(workspaceId, noteId, recordingId, mode);
}
