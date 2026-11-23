import i18next from "i18next";
import { create } from "zustand";
import { numberSpeakers, peopleIn } from "../../../shared/notes/transcript";
import { regroupVoices } from "../../../shared/notes/voices";
import { dismissToast, showToast } from "../../components/ui/toast";
import { readPrints } from "./read-prints";
import { useSecondPassStore } from "./second-pass";
import {
  flushTranscript,
  transcriptKey,
  updateRecording,
  useTranscriptsStore,
} from "./transcripts";
import { clearVoiceSuggestions, refreshVoiceSuggestions } from "./voice-memory";
import { voicePrintAvailable } from "./voice-print";

const UNDO_MS = 12_000;

export const useRegroupStore = create<{ progress: Record<string, number> }>(() => ({
  progress: {},
}));

export function regroupKey(workspaceId: string, noteId: string, recordingId: string): string {
  return `${transcriptKey(workspaceId, noteId)}/${recordingId}`;
}

const t = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`notes:transcript.regroup.${key}`, options ?? {});

export async function regroupRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  target: number | "auto",
  reportFailure = false,
): Promise<void> {
  const key = regroupKey(workspaceId, noteId, recordingId);
  function unavailable(message: string) {
    if (reportFailure) throw new Error(message);
  }
  if (useRegroupStore.getState().progress[key] !== undefined)
    return unavailable("a regroup is already running");
  const current = () =>
    useTranscriptsStore
      .getState()
      .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recordingId);
  const before = current();
  if (!before || before.audioRemoved || !before.takes.length || !before.lines.length)
    return unavailable("the recording needs audio and transcript lines");
  if (useSecondPassStore.getState().running[recordingId])
    return unavailable("the recording is still being transcribed");

  const setProgress = (percent: number) => {
    useRegroupStore.setState((s) =>
      s.progress[key] === percent ? s : { progress: { ...s.progress, [key]: percent } },
    );
  };
  setProgress(0);
  try {
    if (!(await voicePrintAvailable())) throw new Error("Voice prints unavailable");
    let done = 0;
    const samples = await readPrints(workspaceId, noteId, before, {
      onLine: () => {
        if (current() !== before) throw new Error("Recording changed");
        setProgress(Math.min(99, Math.floor((100 * ++done) / before.lines.length)));
      },
    });
    if (!samples.length) throw new Error("No voice prints");
    if (current() !== before) throw new Error("Recording changed");
    const keys = regroupVoices({
      samples,
      names: before.speakers,
      lines: before.lines.map((l) => ({
        at: l.startMs,
        ms: l.endMs - l.startMs,
        key: l.speaker,
        ...(l.pinned ? { pinned: true } : {}),
      })),
      target: target === "auto" ? undefined : target,
    });
    const after = numberSpeakers({
      ...before,
      voicePrint: true,
      participantCount: target,
      lines: before.lines.map((l) => {
        const speaker = keys.get(l.startMs);
        return !speaker || l.pinned || speaker === l.speaker ? l : { ...l, speaker };
      }),
    });
    updateRecording(workspaceId, noteId, recordingId, () => after);
    clearVoiceSuggestions({ workspaceId, noteId, recordingId });
    void refreshVoiceSuggestions({ workspaceId, noteId, recordingId }, samples);
    await flushTranscript(workspaceId, noteId, true, reportFailure);
    const toast = showToast({
      kind: "info",
      message: t("success", { count: peopleIn(after) }),
      actions: [
        {
          label: t("undo"),
          onAction: () => {
            if (current() !== after) return;
            updateRecording(workspaceId, noteId, recordingId, () => before);
            clearVoiceSuggestions({ workspaceId, noteId, recordingId });
            void refreshVoiceSuggestions({ workspaceId, noteId, recordingId }, samples);
            void flushTranscript(workspaceId, noteId, true);
          },
        },
      ],
    });
    const clearUndo = () => {
      unwatch();
      clearTimeout(expiry);
      dismissToast(toast);
    };
    const unwatch = useTranscriptsStore.subscribe(() => {
      if (current() !== after) clearUndo();
    });
    const expiry = setTimeout(clearUndo, UNDO_MS);
  } catch (error) {
    if (reportFailure) throw error;
    showToast({ kind: "error", message: t(current() === before ? "failed" : "changed") });
  } finally {
    useRegroupStore.setState((s) => {
      const { [key]: _done, ...progress } = s.progress;
      return { progress };
    });
  }
}
