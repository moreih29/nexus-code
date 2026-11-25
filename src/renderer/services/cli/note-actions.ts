import type { CliNoteStorageEntry, CliRecorder, CliUiOp } from "../../../shared/cli/ui";
import { noteStorageWhere } from "../../../shared/notes/types";
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

function storageEntryNamed(
  entries: readonly CliNoteStorageEntry[],
  selector: string,
): CliNoteStorageEntry {
  const text = selector.trim();
  const exact =
    entries.find((entry) => entry.location.key === text) ??
    entries.find((entry) => noteStorageWhere(entry) === text || entry.location.path === text);
  if (exact) return exact;
  const named = entries.filter(
    (entry) => entry.location.label.trim().toLowerCase() === text.toLowerCase(),
  );
  if (named.length > 1) {
    throw new UiRequestError(
      `more than one location is named "${selector}"; give its path: ${named.map(noteStorageWhere).join(", ")}`,
    );
  }
  const [found] = named;
  if (!found) {
    throw new UiRequestError(`no notes are kept for "${selector}"; nexus note storage lists them`);
  }
  return found;
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
  "note.storage.remove": async ({ location, approved, before }) => {
    const entries = unwrapIpcResult(await ipcCallResult("notes", "storage", undefined));
    const entry = storageEntryNamed(entries, location);
    const snapshot = JSON.stringify(entry);
    if (approved !== true) return { entry, snapshot, removed: false };
    if (before !== snapshot) {
      throw new UiRequestError(
        "the notes there changed while waiting for the user's approval; run the command again",
      );
    }
    unwrapIpcResult(await ipcCallResult("notes", "removeLocation", { key: entry.location.key }));
    return { entry, snapshot, removed: true };
  },
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
