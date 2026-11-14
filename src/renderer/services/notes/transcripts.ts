/**
 * Notes' transcripts in the renderer: loaded once per note, changed here
 * (by the recorder as words come, by the user naming voices), and written
 * back to transcript.json a moment after each change. One window records;
 * the others read the file when they open the note.
 */
import i18next from "i18next";
import { create } from "zustand";
import {
  EMPTY_TRANSCRIPT,
  type TranscriptFile,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { showToast } from "../../components/ui/toast";
import { notesApi } from "./api";

/** How long after a change the transcript is written. */
export const TRANSCRIPT_SAVE_DELAY_MS = 800;

interface TranscriptsState {
  /** By transcriptKey; missing until loaded. */
  byNote: Record<string, TranscriptFile>;
}

export const useTranscriptsStore = create<TranscriptsState>(() => ({ byNote: {} }));

export function transcriptKey(workspaceId: string, noteId: string): string {
  return `${workspaceId}/${noteId}`;
}

const loading = new Map<string, Promise<TranscriptFile>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writes = new Map<string, Promise<void>>();
let toldSaveFailure = false;

/** The note's transcript, read from its folder the first time. */
export function loadTranscript(workspaceId: string, noteId: string): Promise<TranscriptFile> {
  const key = transcriptKey(workspaceId, noteId);
  const have = useTranscriptsStore.getState().byNote[key];
  if (have) return Promise.resolve(have);
  let pending = loading.get(key);
  if (!pending) {
    pending = notesApi
      .readTranscript(workspaceId, noteId)
      .catch(() => EMPTY_TRANSCRIPT)
      .then((file) => {
        // A change made while it loaded (a recording just started) wins.
        const now = useTranscriptsStore.getState().byNote[key];
        if (now) return now;
        useTranscriptsStore.setState((s) => ({ byNote: { ...s.byNote, [key]: file } }));
        return file;
      })
      .finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Changes the note's transcript (loaded already), and writes it a moment later. */
export function updateTranscript(
  workspaceId: string,
  noteId: string,
  change: (file: TranscriptFile) => TranscriptFile,
): void {
  const key = transcriptKey(workspaceId, noteId);
  const before = useTranscriptsStore.getState().byNote[key] ?? EMPTY_TRANSCRIPT;
  const next = change(before);
  if (next === before) return;
  useTranscriptsStore.setState((s) => ({ byNote: { ...s.byNote, [key]: next } }));
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => void flushTranscript(workspaceId, noteId), TRANSCRIPT_SAVE_DELAY_MS),
  );
}

/** Changes one recording of the note's transcript. */
export function updateRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  change: (recording: TranscriptRecording) => TranscriptRecording,
): void {
  updateTranscript(workspaceId, noteId, (file) => {
    let changed = false;
    const recordings = file.recordings.map((r) => {
      if (r.id !== recordingId) return r;
      const next = change(r);
      if (next !== r) changed = true;
      return next;
    });
    return changed ? { ...file, recordings } : file;
  });
}

/**
 * Writes the note's transcript now (what is waiting to be written, and any
 * write under way); `announce` tells the windows, for a change worth a
 * recount (a recording ended).
 */
export function flushTranscript(
  workspaceId: string,
  noteId: string,
  announce = false,
): Promise<void> {
  const key = transcriptKey(workspaceId, noteId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  const file = useTranscriptsStore.getState().byNote[key];
  const before = writes.get(key) ?? Promise.resolve();
  if (!file) return before;
  const write = before
    .then(() => notesApi.saveTranscript(workspaceId, noteId, file, announce))
    .then(
      () => {
        toldSaveFailure = false;
      },
      (error: unknown) => {
        console.warn("[notes] transcript not saved", error);
        if (toldSaveFailure) return;
        toldSaveFailure = true;
        showToast({
          kind: "error",
          message: i18next.t("notes:transcript.saveFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      },
    );
  writes.set(key, write);
  return write;
}

/** Names a voice of a recording (an empty name takes the name away). */
export function nameSpeaker(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  key: string,
  name: string,
): void {
  updateRecording(workspaceId, noteId, recordingId, (r) => {
    const speakers = { ...r.speakers };
    const trimmed = name.trim().slice(0, 80);
    if (trimmed) speakers[key] = trimmed;
    else delete speakers[key];
    return { ...r, speakers };
  });
}

/** Moves a recording's audio to the Trash, and with `text` its words go too. */
export async function removeRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  text: boolean,
): Promise<void> {
  await flushTranscript(workspaceId, noteId);
  const next = await notesApi.removeRecording(workspaceId, noteId, recordingId, text);
  const key = transcriptKey(workspaceId, noteId);
  useTranscriptsStore.setState((s) => ({ byNote: { ...s.byNote, [key]: next } }));
}

/** Forgets a note's transcript (the note was removed). */
export function dropTranscript(workspaceId: string, noteId: string): void {
  const key = transcriptKey(workspaceId, noteId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  useTranscriptsStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.byNote;
    return { byNote: rest };
  });
}
