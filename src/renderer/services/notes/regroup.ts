import i18next from "i18next";
import { create } from "zustand";
import {
  numberSpeakers,
  peopleIn,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { regroupVoices, type VoiceSample } from "../../../shared/notes/voices";
import { MAX_VOICE_PRINT_SAMPLES } from "../../../shared/types/notes";
import { dismissToast, showToast } from "../../components/ui/toast";
import { notesApi } from "./api";
import { useSecondPassStore } from "./second-pass";
import {
  flushTranscript,
  transcriptKey,
  updateRecording,
  useTranscriptsStore,
} from "./transcripts";
import { MIN_PRINT_MS, VOICE_PRINT_RATE, voicePrintAvailable } from "./voice-print";

const UNDO_MS = 12_000;

export const useRegroupStore = create<{ progress: Record<string, number> }>(() => ({
  progress: {},
}));

export function regroupKey(workspaceId: string, noteId: string, recordingId: string): string {
  return `${transcriptKey(workspaceId, noteId)}/${recordingId}`;
}

const t = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`notes:transcript.regroup.${key}`, options ?? {});

/** A mono window at the model's sample rate, with the same limits as the live tracker. */
function audioWindow(audio: AudioBuffer, startMs: number, endMs: number): Float32Array | null {
  const start = Math.max(0, Math.floor((startMs * VOICE_PRINT_RATE) / 1000));
  const end = Math.min(
    audio.length,
    Math.floor((endMs * VOICE_PRINT_RATE) / 1000),
    start + MAX_VOICE_PRINT_SAMPLES,
  );
  if (end - start < (MIN_PRINT_MS * VOICE_PRINT_RATE) / 1000) return null;
  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice(start, end);
  const mono = new Float32Array(end - start);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = (mono[i] as number) + (samples[start + i] as number) / audio.numberOfChannels;
    }
  }
  return mono;
}

async function readPrints(
  workspaceId: string,
  noteId: string,
  recording: TranscriptRecording,
  onLine: () => void,
): Promise<VoiceSample[]> {
  // Decoding resamples to the context rate. Only one take is kept decoded at a time.
  const context = new OfflineAudioContext(1, 1, VOICE_PRINT_RATE);
  const samples: VoiceSample[] = [];
  for (const [index, take] of recording.takes.entries()) {
    const until = recording.takes[index + 1]?.offsetMs ?? Number.POSITIVE_INFINITY;
    const lines = recording.lines.filter((l) => l.startMs >= take.offsetMs && l.startMs < until);
    if (!lines.length) continue;
    const { base64 } = await notesApi.readAsset(workspaceId, noteId, take.file);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const audio = await context.decodeAudioData(bytes.buffer);
    for (const line of lines) {
      const clip = audioWindow(audio, line.startMs - take.offsetMs, line.endMs - take.offsetMs);
      const vector = clip ? await notesApi.voicePrint(clip) : null;
      if (vector) {
        samples.push({
          at: line.startMs,
          ms: line.endMs - line.startMs,
          key: line.speaker,
          ...(line.pinned ? { pinned: true } : {}),
          vector,
        });
      }
      onLine();
    }
  }
  return samples;
}

/** Recompute voice prints from the local recording and apply one guarded transcript edit. */
export async function regroupRecording(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  target: number,
): Promise<void> {
  const key = regroupKey(workspaceId, noteId, recordingId);
  if (useRegroupStore.getState().progress[key] !== undefined) return;
  const current = () =>
    useTranscriptsStore
      .getState()
      .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recordingId);
  const before = current();
  if (!before || before.audioRemoved || !before.takes.length || !before.lines.length) return;
  if (useSecondPassStore.getState().running[recordingId]) return;

  const setProgress = (percent: number) => {
    useRegroupStore.setState((s) =>
      s.progress[key] === percent ? s : { progress: { ...s.progress, [key]: percent } },
    );
  };
  setProgress(0);
  try {
    if (!(await voicePrintAvailable())) throw new Error("Voice prints unavailable");
    let done = 0;
    const samples = await readPrints(workspaceId, noteId, before, () => {
      if (current() !== before) throw new Error("Recording changed");
      setProgress(Math.min(99, Math.floor((100 * ++done) / before.lines.length)));
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
      target,
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
    void flushTranscript(workspaceId, noteId, true);
    const toast = showToast({
      kind: "info",
      message: t("success", { count: peopleIn(after) }),
      actions: [
        {
          label: t("undo"),
          onAction: () => {
            if (current() !== after) return;
            updateRecording(workspaceId, noteId, recordingId, () => before);
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
  } catch {
    showToast({ kind: "error", message: t(current() === before ? "failed" : "changed") });
  } finally {
    useRegroupStore.setState((s) => {
      const { [key]: _done, ...progress } = s.progress;
      return { progress };
    });
  }
}
