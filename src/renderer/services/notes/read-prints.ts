import type { TranscriptLine, TranscriptRecording } from "../../../shared/notes/transcript";
import type { VoiceSample } from "../../../shared/notes/voices";
import { MAX_VOICE_PRINT_SAMPLES } from "../../../shared/types/notes";
import { notesApi } from "./api";
import { MIN_PRINT_MS, VOICE_PRINT_RATE } from "./voice-print";

/** A mono window at the model's sample rate, with the same limits as the live tracker. */
function audioWindow(
  audio: AudioBuffer,
  startMs: number,
  endMs: number,
  minimumMs: number,
): Float32Array | null {
  const start = Math.max(0, Math.floor((startMs * VOICE_PRINT_RATE) / 1000));
  const end = Math.min(
    audio.length,
    Math.floor((endMs * VOICE_PRINT_RATE) / 1000),
    start + MAX_VOICE_PRINT_SAMPLES,
  );
  if (end - start < (minimumMs * VOICE_PRINT_RATE) / 1000) return null;
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

/** Reads only the requested lines of a recording. The decoded take is released before the next one. */
export async function readPrints(
  workspaceId: string,
  noteId: string,
  recording: TranscriptRecording,
  {
    lines = recording.lines,
    minimumMs = MIN_PRINT_MS,
    onLine,
  }: {
    lines?: readonly TranscriptLine[];
    minimumMs?: number;
    onLine?: () => void;
  } = {},
): Promise<VoiceSample[]> {
  // Decoding resamples to the context rate. Only one take is kept decoded at a time.
  if (recording.audioRemoved || !recording.takes.length) return [];
  const eligible = onLine ? lines : lines.filter((line) => line.endMs - line.startMs >= minimumMs);
  if (!eligible.length) return [];
  const context = new OfflineAudioContext(1, 1, VOICE_PRINT_RATE);
  const samples: VoiceSample[] = [];
  for (const [index, take] of recording.takes.entries()) {
    const until = recording.takes[index + 1]?.offsetMs ?? Number.POSITIVE_INFINITY;
    const takeLines = eligible.filter((l) => l.startMs >= take.offsetMs && l.startMs < until);
    if (!takeLines.length) continue;
    const { base64 } = await notesApi.readAsset(workspaceId, noteId, take.file);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const audio = await context.decodeAudioData(bytes.buffer);
    for (const line of takeLines) {
      const clip = audioWindow(
        audio,
        line.startMs - take.offsetMs,
        line.endMs - take.offsetMs,
        minimumMs,
      );
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
      onLine?.();
    }
  }
  return samples;
}
