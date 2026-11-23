import type { CliRecorder, CliUiOp } from "../../../shared/cli/ui";
import { type ToastInput, watchToasts } from "../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { openOrRevealNoteTab } from "../../state/operations/tabs";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { notesApi } from "../notes/api";
import {
  pauseRecording,
  recorderElapsedMs,
  resumeRecording,
  startRecording,
  stopRecording,
  useRecorderStore,
} from "../notes/recorder";
import { voiceAvailabilityNow, voiceLanguage } from "../voice/availability";
import { type CliUiHandler, UiRequestError } from "./handler";

import { noteSpeakerHandlers } from "./note-speakers";

type NoteOp = Extract<CliUiOp, `note.${string}`>;

function recorderNow(voice: CliRecorder["voice"]): CliRecorder {
  const s = useRecorderStore.getState();
  if (s.phase === "idle" || !s.workspaceId || !s.noteId) return { phase: "idle", voice };
  return {
    phase: s.phase,
    workspaceId: s.workspaceId,
    noteId: s.noteId,
    elapsedMs: Math.round(recorderElapsedMs(s)),
    voice,
  };
}

function showNote(workspaceId: string, noteId: string, title?: string): void {
  activateWorkspace(workspaceId);
  openOrRevealNoteTab(workspaceId, noteId, title);
}

export const noteHandlers: { [K in NoteOp]: CliUiHandler<K> } = {
  ...noteSpeakerHandlers,
  "note.rename": async ({ workspaceId, noteId, title }) => {
    const result = await notesApi.save(workspaceId, noteId, { title });
    return { title: result.title };
  },
  "note.storage": async () => ({
    entries: unwrapIpcResult(await ipcCallResult("notes", "storage", undefined)),
  }),
  "note.show": async ({ workspaceId, noteId, title }) => {
    showNote(workspaceId, noteId, title);
    return {};
  },

  "note.recorder": async ({ action, workspaceId, noteId, participants }) => {
    const voice = await voiceAvailabilityNow();
    const phase = useRecorderStore.getState().phase;
    switch (action) {
      case "status":
        return recorderNow(voice);
      case "pause":
        if (phase !== "recording") throw new UiRequestError("nothing records now");
        pauseRecording();
        return recorderNow(voice);
      case "resume":
        if (phase !== "paused") throw new UiRequestError("no recording is paused");
        await resumeRecording();
        return recorderNow(voice);
      case "stop":
        if (phase === "idle") throw new UiRequestError("nothing records now");
        stopRecording();
        return recorderNow(voice);
      case "start": {
        if (!workspaceId || !noteId) throw new UiRequestError("which note to record into");
        if (voice === "signed-out") {
          throw new UiRequestError("recording needs a NexusCode sign-in (Settings › Remote)");
        }
        if (voice === "unavailable") {
          throw new UiRequestError("the NexusCode server signed in to has no voice recognition");
        }
        const s = useRecorderStore.getState();
        if (s.phase !== "idle" && (s.workspaceId !== workspaceId || s.noteId !== noteId)) {
          throw new UiRequestError("another note records now: one at a time");
        }
        showNote(workspaceId, noteId);
        const said: ToastInput[] = [];
        const stopWatching = watchToasts((toast) => said.push(toast));
        try {
          await startRecording(workspaceId, noteId, voiceLanguage(), participants);
        } finally {
          stopWatching();
        }
        const now = recorderNow(voice);
        if (now.phase === "idle" || now.noteId !== noteId) {
          const why = said.find((toast) => toast.kind === "error") ?? said[0];
          throw new UiRequestError(`it did not start${why ? `: ${why.message}` : ""}`);
        }
        return now;
      }
    }
  },
};
