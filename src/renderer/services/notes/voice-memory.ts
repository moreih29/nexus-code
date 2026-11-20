import { create } from "zustand";
import { type TranscriptRecording, withRejectedVoiceName } from "../../../shared/notes/transcript";
import {
  speakerPrints,
  VOICE_NAME_LINE_MS,
  type VoiceNameStatus,
  type VoiceNameSuggestion,
  voiceNameCandidates,
} from "../../../shared/notes/voice-names";
import type { VoiceSample } from "../../../shared/notes/voices";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { readPrints } from "./read-prints";
import {
  flushTranscript,
  transcriptKey,
  updateRecording,
  useTranscriptsStore,
} from "./transcripts";
import { voicePrintAvailable } from "./voice-print";

export interface RecordingRef {
  workspaceId: string;
  noteId: string;
  recordingId: string;
}

export function voiceSuggestionKey({ workspaceId, noteId, recordingId }: RecordingRef): string {
  return `${transcriptKey(workspaceId, noteId)}/${recordingId}`;
}

interface VoiceMemoryState {
  status: VoiceNameStatus | null;
  byRecording: Record<string, readonly VoiceNameSuggestion[]>;
  searching: Record<string, true>;
}

export const useVoiceMemory = create<VoiceMemoryState>(() => ({
  status: null,
  byRecording: {},
  searching: {},
}));

export const voiceMemoryApi = {
  list: async () => unwrapIpcResult(await ipcCallResult("voiceMemory", "list", undefined)),
  configure: async (change: { suggest?: boolean; expire?: boolean }) =>
    applyStatus(unwrapIpcResult(await ipcCallResult("voiceMemory", "configure", change))),
  consent: async (allowed: boolean) =>
    applyStatus(unwrapIpcResult(await ipcCallResult("voiceMemory", "consent", { allowed }))),
  remove: async (name: string) =>
    unwrapIpcResult(await ipcCallResult("voiceMemory", "remove", { name })),
  clear: async () => unwrapIpcResult(await ipcCallResult("voiceMemory", "clear", undefined)),
};

function applyStatus(status: VoiceNameStatus): VoiceNameStatus {
  const before = useVoiceMemory.getState().status;
  if (before && before.revision > status.revision) return before;
  useVoiceMemory.setState(
    before && before.revision !== status.revision ? { status, byRecording: {} } : { status },
  );
  return status;
}

let subscribed = false;
let loading: Promise<VoiceNameStatus | null> | undefined;

export function loadVoiceMemory(): Promise<VoiceNameStatus | null> {
  const loaded = useVoiceMemory.getState().status;
  if (loaded) return Promise.resolve(loaded);
  loading ??= Promise.resolve()
    .then(() => {
      if (!subscribed) {
        ipcListen("voiceMemory", "changed", applyStatus);
        subscribed = true;
      }
      return ipcCallResult("voiceMemory", "status", undefined);
    })
    .then((result) => applyStatus(unwrapIpcResult(result)))
    .catch(() => null)
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

function recordingOf({ workspaceId, noteId, recordingId }: RecordingRef) {
  return useTranscriptsStore
    .getState()
    .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recordingId);
}

export function hasVoiceAudio(recording: TranscriptRecording): boolean {
  return !recording.audioRemoved && recording.takes.length > 0;
}

export function canSuggestNames(status: VoiceNameStatus | null): boolean {
  return Boolean(
    status?.available && status.suggest && status.consent === "allowed" && status.count,
  );
}

export const NO_VOICE_SUGGESTIONS: readonly VoiceNameSuggestion[] = [];

export function visibleVoiceSuggestions(
  recording: TranscriptRecording,
  suggestions: readonly VoiceNameSuggestion[] = NO_VOICE_SUGGESTIONS,
): readonly VoiceNameSuggestion[] {
  if (!hasVoiceAudio(recording) || !suggestions.length) return NO_VOICE_SUGGESTIONS;
  const keys = new Set(recording.lines.map((line) => line.speaker));
  const named = new Set(Object.values(recording.speakers).map((name) => name.trim()));
  return suggestions.filter(
    ({ key, name }) =>
      keys.has(key) &&
      !recording.speakers[key]?.trim() &&
      !named.has(name) &&
      !recording.rejectedVoiceNames?.[key]?.includes(name),
  );
}

const jobs = new Map<string, symbol>();

function putSuggestions(key: string, suggestions: readonly VoiceNameSuggestion[]): void {
  useVoiceMemory.setState(({ byRecording }) => {
    const previous = byRecording[key];
    if (
      (previous?.length ?? 0) === suggestions.length &&
      suggestions.every(
        ({ key, name }, i) => previous?.[i]?.key === key && previous[i]?.name === name,
      )
    )
      return {};
    if (!suggestions.length) {
      const { [key]: _removed, ...rest } = byRecording;
      return { byRecording: rest };
    }
    return { byRecording: { ...byRecording, [key]: suggestions } };
  });
}

export function clearVoiceSuggestions(ref: RecordingRef): void {
  const key = voiceSuggestionKey(ref);
  jobs.delete(key);
  putSuggestions(key, []);
}

export function dismissVoiceSuggestions(ref: RecordingRef, keys: readonly string[]): void {
  const key = voiceSuggestionKey(ref);
  const previous = useVoiceMemory.getState().byRecording[key];
  if (previous)
    putSuggestions(
      key,
      previous.filter((s) => !keys.includes(s.key)),
    );
}

type SearchResult = "found" | "empty" | "unavailable" | "changed" | "failed";

async function findSuggestions(
  ref: RecordingRef,
  samples: readonly VoiceSample[] | undefined,
  live: boolean,
): Promise<SearchResult> {
  const key = voiceSuggestionKey(ref);
  const before = recordingOf(ref);
  if (!before || !hasVoiceAudio(before)) return "unavailable";
  const job = Symbol();
  jobs.set(key, job);
  try {
    const status = await loadVoiceMemory();
    if (!status || !canSuggestNames(status)) return "unavailable";
    if (jobs.get(key) !== job) return "changed";
    const current = () => {
      const after = recordingOf(ref);
      return (
        jobs.get(key) === job &&
        after !== undefined &&
        hasVoiceAudio(after) &&
        useVoiceMemory.getState().status?.revision === status.revision &&
        before.speakers === after.speakers &&
        before.rejectedVoiceNames === after.rejectedVoiceNames &&
        (before.lines === after.lines ||
          (live && before.lines.every((line, index) => line === after.lines[index])))
      );
    };
    if (!current()) return "changed";
    const { workspaceId, noteId } = ref;
    const prints =
      samples ??
      (await readPrints(workspaceId, noteId, before, {
        lines: before.lines.filter((line) => !before.speakers[line.speaker]?.trim()),
        minimumMs: VOICE_NAME_LINE_MS,
        onLine: () => {
          if (!current()) throw new Error("Recording changed");
        },
      }));
    if (!current()) return "changed";
    const candidates = voiceNameCandidates(before, prints);
    const found = candidates.speakers.length
      ? unwrapIpcResult(
          await ipcCallResult("voiceMemory", "match", { ...candidates, revision: status.revision }),
        )
      : [];
    if (!current()) return "changed";
    putSuggestions(key, found);
    return found.length ? "found" : "empty";
  } catch {
    return jobs.get(key) === job ? "failed" : "changed";
  } finally {
    if (jobs.get(key) === job) jobs.delete(key);
  }
}

export async function refreshVoiceSuggestions(
  ref: RecordingRef,
  samples: readonly VoiceSample[],
  live = false,
): Promise<void> {
  await findSuggestions(ref, samples, live);
}

export async function searchVoiceSuggestions(ref: RecordingRef): Promise<SearchResult> {
  const key = voiceSuggestionKey(ref);
  if (useVoiceMemory.getState().searching[key]) return "changed";
  useVoiceMemory.setState(({ searching }) => ({ searching: { ...searching, [key]: true } }));
  try {
    if (!(await voicePrintAvailable())) return "unavailable";
    return await findSuggestions(ref, undefined, false);
  } finally {
    useVoiceMemory.setState(({ searching }) => {
      const { [key]: _removed, ...rest } = searching;
      return { searching: rest };
    });
  }
}

export function currentVoiceSuggestions(ref: RecordingRef): readonly VoiceNameSuggestion[] {
  const recording = recordingOf(ref);
  return recording
    ? visibleVoiceSuggestions(
        recording,
        useVoiceMemory.getState().byRecording[voiceSuggestionKey(ref)],
      )
    : NO_VOICE_SUGGESTIONS;
}

export async function rejectVoiceSuggestion(
  ref: RecordingRef,
  suggestion: VoiceNameSuggestion,
): Promise<void> {
  if (
    !currentVoiceSuggestions(ref).some(
      ({ key, name }) => key === suggestion.key && name === suggestion.name,
    )
  )
    return;
  const { workspaceId, noteId, recordingId } = ref;
  const { key, name } = suggestion;
  const suggestionKey = voiceSuggestionKey(ref);
  putSuggestions(
    suggestionKey,
    currentVoiceSuggestions(ref).filter((s) => s.key !== key),
  );
  updateRecording(workspaceId, noteId, recordingId, (recording) =>
    withRejectedVoiceName(recording, key, name),
  );
  await flushTranscript(workspaceId, noteId);
}

export async function rememberNamedVoice(
  ref: RecordingRef,
  keys: readonly string[],
  name: string,
  status: VoiceNameStatus,
  liveSamples: () => readonly VoiceSample[] | null,
): Promise<void> {
  const before = recordingOf(ref);
  const [key] = keys;
  if (
    !status.available ||
    status.consent !== "allowed" ||
    !before ||
    !key ||
    !hasVoiceAudio(before)
  )
    return;
  const selected = new Set(keys);
  const ownLines = (r: TranscriptRecording) => r.lines.filter((l) => selected.has(l.speaker));
  const lines = ownLines(before);
  const samples =
    liveSamples() ??
    (await readPrints(ref.workspaceId, ref.noteId, before, {
      lines,
      minimumMs: VOICE_NAME_LINE_MS,
    }));
  const after = recordingOf(ref);
  if (!after || !hasVoiceAudio(after) || !keys.every((key) => after.speakers[key] === name)) return;
  const latest = ownLines(after);
  if (!lines.every((line, i) => line === latest[i])) return;
  const vector = speakerPrints({ lines: lines.map((l) => ({ ...l, speaker: key })) }, samples).get(
    key,
  );
  if (!vector) return;
  unwrapIpcResult(
    await ipcCallResult("voiceMemory", "learn", {
      revision: status.revision,
      name,
      recordingId: ref.recordingId,
      recordedAt: before.startedAt,
      vector,
    }),
  );
}
