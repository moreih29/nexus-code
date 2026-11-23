import { notesApi } from "../services/notes/api";
import { dropRecording, useRecorderStore } from "../services/notes/recorder";
import { dropRemovedTranscripts } from "../services/notes/transcripts";
import { closeNoteTabs } from "./operations";
import { useTabsStore } from "./stores/tabs";

export function startNoteRemovalListener(): () => void {
  return notesApi.onChanged((event) => {
    if (event.change !== "removed") return;
    const byWorkspace = useTabsStore.getState().byWorkspace;
    const affectedWorkspaces = new Set(event.workspaceIds);
    const recording = useRecorderStore.getState();
    if (
      recording.workspaceId &&
      recording.noteId &&
      (event.noteId
        ? event.noteId === recording.noteId
        : affectedWorkspaces.has(recording.workspaceId))
    ) {
      dropRecording(recording.workspaceId, recording.noteId);
    }
    dropRemovedTranscripts(affectedWorkspaces, event.noteId);
    for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
      if (!event.noteId && !affectedWorkspaces.has(workspaceId)) continue;
      for (const tab of Object.values(tabs ?? {})) {
        if (tab.type !== "note") continue;
        const { noteId } = tab.props;
        if (!event.noteId || noteId === event.noteId) closeNoteTabs(workspaceId, noteId);
      }
    }
  });
}
