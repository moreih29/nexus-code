import i18next from "i18next";
import { create } from "zustand";
import {
  EMPTY_TRANSCRIPT,
  numberSpeakers,
  type TranscriptEdit,
  type TranscriptFile,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { showToast } from "../../components/ui/toast";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { notesApi } from "./api";

export const TRANSCRIPT_SAVE_DELAY_MS = 800;

interface TranscriptsState {
  byNote: Record<string, TranscriptFile>;
}

export const useTranscriptsStore = create<TranscriptsState>(() => ({ byNote: {} }));

export function transcriptKey(workspaceId: string, noteId: string): string {
  const workspaces = useWorkspacesStore.getState().workspaces;
  const parentId = workspaces.find((workspace) => workspace.id === workspaceId)?.task?.parentId;
  const owner =
    parentId && workspaces.some((workspace) => workspace.id === parentId) ? parentId : workspaceId;
  return `${owner}/${noteId}`;
}

const loading = new Map<string, Promise<TranscriptFile>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writes = new Map<string, Promise<void>>();
const savedFiles = new Map<string, TranscriptFile>();
let toldSaveFailure = false;

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
        if (loading.get(key) !== pending) return EMPTY_TRANSCRIPT;
        const now = useTranscriptsStore.getState().byNote[key];
        if (now) return now;
        const numbered = {
          ...file,
          recordings: file.recordings.map((r) => (r.speakerNumbers ? r : numberSpeakers(r))),
        };
        savedFiles.set(key, numbered);
        useTranscriptsStore.setState((s) => ({ byNote: { ...s.byNote, [key]: numbered } }));
        return numbered;
      })
      .finally(() => {
        if (loading.get(key) === pending) loading.delete(key);
      });
    loading.set(key, pending);
  }
  return pending;
}

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

export function flushTranscript(
  workspaceId: string,
  noteId: string,
  announce = false,
  reportFailure = false,
): Promise<void> {
  const key = transcriptKey(workspaceId, noteId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  const file = useTranscriptsStore.getState().byNote[key];
  const before = writes.get(key) ?? Promise.resolve();
  if (!file) return before;
  const write = before.then(async () => {
    if (!useTranscriptsStore.getState().byNote[key]) return;
    const saved = savedFiles.get(key) ?? EMPTY_TRANSCRIPT;
    const edits = changedRecordings(saved, file);
    if (!edits.length && !announce) return;
    await notesApi.saveTranscript(workspaceId, noteId, edits, announce);
    if (useTranscriptsStore.getState().byNote[key]) savedFiles.set(key, file);
  });
  const reported = write.then(
    () => {
      toldSaveFailure = false;
    },
    (error: unknown) => {
      console.warn("[notes] transcript not saved", error);
      if (toldSaveFailure) return;
      toldSaveFailure = true;
      showToast({
        kind: "error",
        message:
          error instanceof Error && "kind" in error && error.kind === "conflict"
            ? i18next.t("notes:transcript.saveConflict")
            : i18next.t("notes:transcript.saveFailed", {
                message: error instanceof Error ? error.message : String(error),
              }),
      });
    },
  );
  writes.set(key, reported);
  void reported.then(() => {
    if (writes.get(key) === reported) writes.delete(key);
  });
  return reportFailure ? write : reported;
}

function changedRecordings(saved: TranscriptFile, file: TranscriptFile): TranscriptEdit[] {
  const previous = new Map(saved.recordings.map((recording) => [recording.id, recording]));
  const edits: TranscriptEdit[] = [];
  for (const after of file.recordings) {
    const before = previous.get(after.id);
    previous.delete(after.id);
    if (before !== after) edits.push({ id: after.id, ...(before && { before }), after });
  }
  for (const [id, before] of previous) edits.push({ id, before });
  return edits;
}

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
    const next = { ...r, speakers };
    return r.speakerNumbers ? numberSpeakers(next) : next;
  });
}

export async function removeRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  text: boolean,
): Promise<void> {
  await flushTranscript(workspaceId, noteId, false, true);
  const next = await notesApi.removeRecording(workspaceId, noteId, recordingId, text);
  const key = transcriptKey(workspaceId, noteId);
  savedFiles.set(key, next);
  useTranscriptsStore.setState((s) => ({ byNote: { ...s.byNote, [key]: next } }));
}

export function dropTranscript(workspaceId: string, noteId: string): void {
  const key = transcriptKey(workspaceId, noteId);
  loading.delete(key);
  savedFiles.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
  useTranscriptsStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.byNote;
    return { byNote: rest };
  });
}

export function dropRemovedTranscripts(workspaceIds: ReadonlySet<string>, noteId?: string): void {
  const keys = new Set([...Object.keys(useTranscriptsStore.getState().byNote), ...loading.keys()]);
  for (const key of keys) {
    const slash = key.indexOf("/");
    const workspaceId = key.slice(0, slash);
    const id = key.slice(slash + 1);
    if (noteId ? id === noteId : workspaceIds.has(workspaceId)) dropTranscript(workspaceId, id);
  }
}
