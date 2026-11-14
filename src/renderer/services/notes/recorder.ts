/**
 * Recording into a note, one at a time across the window: the microphone
 * goes to the server's voice socket as PCM (for the words, as they are
 * said, with who said them) and, at the same time, into an Opus file in the
 * note's recordings/ (for the second pass, and to keep). It goes on while
 * the user works elsewhere in the app.
 *
 * A recording is made of takes, one per voice session: pausing ends a take
 * (the microphone goes off), going on starts the next; a session that runs
 * out of time (`limit: session`) goes straight on in a new take.
 */
import i18next from "i18next";
import { create } from "zustand";
import {
  peopleIn,
  speakerKey,
  type TranscriptRecording,
  takeFile,
} from "../../../shared/notes/transcript";
import type { VoiceEvent } from "../../../shared/remote/voice";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { type Capture, CaptureError, openMicrophone, startCapture } from "../voice/capture";
import { tellFailure } from "../voice/dictation";
import { notesApi } from "./api";
import { runSecondPass } from "./second-pass";
import { flushTranscript, loadTranscript, updateRecording, updateTranscript } from "./transcripts";

/** How much audio each piece written to the take's file holds. */
export const AUDIO_SLICE_MS = 3000;
/** The Opus bitrate: speech is clear at it, and an hour is about 14 MB. */
export const AUDIO_BITS_PER_SECOND = 32_000;
/** How long after a take is ended the rest of its words may take. */
export const TAKE_END_TIMEOUT_MS = 10_000;

export type RecorderPhase = "idle" | "starting" | "recording" | "pausing" | "paused" | "stopping";

interface RecorderState {
  phase: RecorderPhase;
  workspaceId: string | null;
  noteId: string | null;
  recordingId: string | null;
  /** The recording's length before the take being recorded. */
  baseMs: number;
  /** When the take being recorded began to listen (epoch ms). */
  takeSince: number | null;
  /** The words of the segment being said, before they are final. */
  partial: { speaker: string; text: string } | null;
  /** How loud the microphone is, 0 to 1. */
  level: number;
}

const IDLE: RecorderState = {
  phase: "idle",
  workspaceId: null,
  noteId: null,
  recordingId: null,
  baseMs: 0,
  takeSince: null,
  partial: null,
  level: 0,
};

export const useRecorderStore = create<RecorderState>(() => IDLE);

/** How long the recording has been, now. */
export function recorderElapsedMs(s: RecorderState, now = Date.now()): number {
  return s.baseMs + (s.takeSince ? now - s.takeSince : 0);
}

type Ending = "pause" | "stop" | "chain";

interface Active {
  workspaceId: string;
  noteId: string;
  recordingId: string;
  language: string;
  /** The take being recorded (0-based); -1 before the first. */
  take: number;
  stream: MediaStream | null;
  capture: Capture | null;
  media: MediaRecorder | null;
  /** The take's voice session. */
  sessionId: string | null;
  /** Where the take starts in the recording. */
  offsetMs: number;
  takeSince: number;
  ending: Ending | null;
  /** The take's audio, written in order. */
  writes: Promise<void>;
  /** The take's file is written to the end (its recorder stopped). */
  mediaDone: Promise<void>;
  endTimer?: ReturnType<typeof setTimeout>;
  levelTimer?: ReturnType<typeof setInterval>;
}

let active: Active | null = null;
let listening = false;

const t = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`notes:recorder.${key}`, options ?? {});

export function newRecordingId(now = Date.now()): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `r${now.toString(36)}${hex}`;
}

function set(state: Partial<RecorderState>): void {
  useRecorderStore.setState(state);
}

function listen(): void {
  if (listening) return;
  listening = true;
  ipcListen("remote", "voiceEvent", onEvent);
}

function update(change: (r: TranscriptRecording) => TranscriptRecording): void {
  const a = active;
  if (a) updateRecording(a.workspaceId, a.noteId, a.recordingId, change);
}

function setTake(
  change: (take: TranscriptRecording["takes"][number]) => TranscriptRecording["takes"][number],
): void {
  const a = active;
  if (!a) return;
  const index = a.take;
  update((r) => ({ ...r, takes: r.takes.map((tk, i) => (i === index ? change(tk) : tk)) }));
}

function onEvent({ id, event }: VoiceEvent): void {
  const a = active;
  if (!a || a.sessionId !== id) return;
  switch (event.t) {
    case "partial": {
      const text = event.text.trim();
      set({ partial: text ? { speaker: speakerKey(a.take, event.speaker ?? "1"), text } : null });
      return;
    }
    case "final": {
      const text = event.text.trim();
      set({ partial: null });
      if (!text) return;
      const now = Date.now() - a.takeSince;
      const line = {
        speaker: speakerKey(a.take, event.speaker ?? "1"),
        startMs: a.offsetMs + (event.startMs ?? Math.max(0, now - 2000)),
        endMs: a.offsetMs + (event.endMs ?? now),
        text,
      };
      update((r) => ({ ...r, lines: [...r.lines, line] }));
      return;
    }
    case "limit":
      if (event.reason === "quota") showToast({ kind: "info", message: t("limit.quota") });
      endTake(event.reason === "session" ? "chain" : "stop");
      return;
    case "error":
      if (event.code === "unauthorized") tellFailure("signed-out");
      else showToast({ kind: "error", message: t("failure.recognition") });
      return;
    case "done":
      setTake((tk) => ({
        ...tk,
        seconds: Math.max(tk.seconds, event.seconds),
        ...(event.transcribeToken ? { token: event.transcribeToken } : {}),
      }));
      return;
    case "ready":
      return;
    case "closed":
      if (event.code === 4001) tellFailure("signed-out");
      else if (event.code !== 1000 && !a.ending) {
        showToast({ kind: "error", message: t("failure.dropped") });
      }
      void finishTake(a);
      return;
  }
}

/**
 * Starts recording into the note, or goes on with its paused recording.
 * Another note's recording is left alone: one at a time.
 */
export async function startRecording(
  workspaceId: string,
  noteId: string,
  language: string,
): Promise<void> {
  const a = active;
  if (a) {
    if (
      a.workspaceId === workspaceId &&
      a.noteId === noteId &&
      useRecorderStore.getState().phase === "paused"
    )
      await resumeRecording();
    return;
  }
  listen();
  const recordingId = newRecordingId();
  const mine: Active = {
    workspaceId,
    noteId,
    recordingId,
    language,
    take: -1,
    stream: null,
    capture: null,
    media: null,
    sessionId: null,
    offsetMs: 0,
    takeSince: 0,
    ending: null,
    writes: Promise.resolve(),
    mediaDone: Promise.resolve(),
  };
  active = mine;
  set({ ...IDLE, phase: "starting", workspaceId, noteId, recordingId });
  await loadTranscript(workspaceId, noteId);
  updateTranscript(workspaceId, noteId, (file) => ({
    ...file,
    recordings: [
      ...file.recordings,
      { id: recordingId, startedAt: Date.now(), language, takes: [], speakers: {}, lines: [] },
    ],
  }));
  if (!(await startTake(mine))) {
    // Nothing was recorded: the recording goes.
    updateTranscript(workspaceId, noteId, (file) => ({
      ...file,
      recordings: file.recordings.filter((r) => r.id !== recordingId),
    }));
    void flushTranscript(workspaceId, noteId);
    if (active === mine) {
      active = null;
      set(IDLE);
    }
  }
}

/** Goes on with the paused recording, in a new take. */
export async function resumeRecording(): Promise<void> {
  const a = active;
  if (!a || useRecorderStore.getState().phase !== "paused") return;
  set({ phase: "starting" });
  if (!(await startTake(a)) && active === a) set({ phase: "paused" });
}

/** Opens the microphone (if it is not open) and a voice session, and records a take; false if it could not. */
async function startTake(a: Active): Promise<boolean> {
  if (!a.stream) {
    const access = await ipcCallResult("remote", "voiceMicrophone", undefined);
    if (!access.ok || access.value === "denied") {
      tellFailure("denied");
      return false;
    }
    try {
      a.stream = await openMicrophone();
    } catch (error) {
      tellFailure(error instanceof CaptureError ? error.reason : "failed");
      return false;
    }
  }
  const started = await ipcCallResult("remote", "voiceStart", {
    language: a.language,
    purpose: "note",
  });
  if (!started.ok || started.value.status === "failed") {
    tellFailure(started.ok && started.value.status === "failed" ? started.value.reason : "failed");
    releaseMicrophone(a);
    return false;
  }
  if (active !== a) {
    void ipcCallResult("remote", "voiceCancel", { id: started.value.id });
    return false;
  }
  const { id, sampleRate } = started.value;
  const stream = a.stream;
  try {
    a.capture = await startCapture(
      stream,
      sampleRate,
      (audio) => void ipcCallResult("remote", "voiceAudio", { id, audio }),
      { keepStream: true },
    );
  } catch (error) {
    void ipcCallResult("remote", "voiceCancel", { id });
    tellFailure(error instanceof CaptureError ? error.reason : "failed");
    releaseMicrophone(a);
    return false;
  }
  a.take += 1;
  a.sessionId = id;
  a.ending = null;
  // The first take starts the recording; the next go on where the last ended.
  a.offsetMs = a.take === 0 ? 0 : useRecorderStore.getState().baseMs;
  a.takeSince = Date.now();
  const file = takeFile(a.recordingId, a.take);
  a.media = recordAudio(a, stream, file);
  update((r) => ({
    ...r,
    takes: [...r.takes, { file, offsetMs: a.offsetMs, seconds: 0, pass: "none" }],
  }));
  a.levelTimer = setInterval(() => {
    if (active === a && a.capture) set({ level: a.capture.level() });
  }, 100);
  set({ phase: "recording", baseMs: a.offsetMs, takeSince: a.takeSince, partial: null });
  return true;
}

/** Records the stream as Opus into the take's file, a piece every AUDIO_SLICE_MS. */
function recordAudio(a: Active, stream: MediaStream, file: string): MediaRecorder | null {
  const type = "audio/webm;codecs=opus";
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported(type)) return null;
  const media = new MediaRecorder(stream, {
    mimeType: type,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });
  const { workspaceId, noteId } = a;
  let failed = false;
  media.ondataavailable = (e) => {
    if (!e.data.size) return;
    const piece = e.data;
    a.writes = a.writes.then(async () => {
      try {
        await notesApi.appendAudio(
          workspaceId,
          noteId,
          file,
          new Uint8Array(await piece.arrayBuffer()),
        );
      } catch (error) {
        console.warn("[notes] recording not written", error);
        if (!failed) showToast({ kind: "error", message: t("failure.write") });
        failed = true;
      }
    });
  };
  a.mediaDone = new Promise((resolve) => {
    media.onstop = () => resolve();
    media.onerror = () => resolve();
  });
  media.start(AUDIO_SLICE_MS);
  return media;
}

/** Ends the take: no more audio; the server sends the rest of its words, then closes. */
function endTake(ending: Ending): void {
  const a = active;
  if (!a?.sessionId || a.ending) return;
  a.ending = ending;
  stopCapture(a);
  const elapsed = Date.now() - a.takeSince;
  setTake((tk) => ({ ...tk, seconds: Math.max(tk.seconds, elapsed / 1000) }));
  if (ending === "chain") set({ partial: null });
  else set({ phase: ending === "pause" ? "pausing" : "stopping", level: 0 });
  const id = a.sessionId;
  void ipcCallResult("remote", "voiceStop", { id });
  a.endTimer = setTimeout(() => {
    if (active === a && a.sessionId === id) {
      void ipcCallResult("remote", "voiceCancel", { id });
      void finishTake(a);
    }
  }, TAKE_END_TIMEOUT_MS);
}

function stopCapture(a: Active): void {
  a.capture?.stop();
  a.capture = null;
  clearInterval(a.levelTimer);
  if (a.media && a.media.state !== "inactive") a.media.stop();
}

function releaseMicrophone(a: Active): void {
  for (const track of a.stream?.getTracks() ?? []) track.stop();
  a.stream = null;
}

/** The take's session closed: its file is written out, then the recording pauses, stops or goes on. */
async function finishTake(a: Active): Promise<void> {
  if (!a.sessionId) return;
  a.sessionId = null;
  clearTimeout(a.endTimer);
  // Closed without being ended (it dropped): what was heard is kept, and the recording pauses.
  const ending = a.ending ?? "pause";
  if (!a.ending) {
    a.ending = ending;
    stopCapture(a);
    const elapsed = Date.now() - a.takeSince;
    setTake((tk) => ({ ...tk, seconds: Math.max(tk.seconds, elapsed / 1000) }));
  }
  const length = Date.now() - a.takeSince;
  await a.mediaDone;
  await a.writes;
  a.media = null;
  if (active !== a) return;
  const baseMs = a.offsetMs + length;
  if (ending === "chain") {
    set({ baseMs, takeSince: null });
    set({ phase: "starting" });
    if (!(await startTake(a)) && active === a) {
      releaseMicrophone(a);
      set({ phase: "paused", level: 0 });
    }
    return;
  }
  releaseMicrophone(a);
  if (ending === "pause") {
    set({ phase: "paused", baseMs, takeSince: null, partial: null, level: 0 });
    await flushTranscript(a.workspaceId, a.noteId, true);
    return;
  }
  await finishRecording(a);
}

async function finishRecording(a: Active): Promise<void> {
  active = null;
  set(IDLE);
  await flushTranscript(a.workspaceId, a.noteId, true);
  const file = await loadTranscript(a.workspaceId, a.noteId);
  const recording = file.recordings.find((r) => r.id === a.recordingId);
  if (!recording) return;
  // Words of more than one person: a meeting, which the second pass hears better. One: done.
  if (peopleIn(recording) >= 2) void runSecondPass(a.workspaceId, a.noteId, a.recordingId);
}

/** Pauses the recording: the take ends, and the microphone goes off. */
export function pauseRecording(): void {
  if (useRecorderStore.getState().phase === "recording") endTake("pause");
}

/** Stops the recording. */
export function stopRecording(): void {
  const a = active;
  if (!a) return;
  const phase = useRecorderStore.getState().phase;
  if (phase === "recording") endTake("stop");
  else if (phase === "paused") void finishRecording(a);
}

/** The note was removed: its recording is dropped. */
export function dropRecording(workspaceId: string, noteId: string): void {
  const a = active;
  if (!a || a.workspaceId !== workspaceId || a.noteId !== noteId) return;
  active = null;
  if (a.sessionId) void ipcCallResult("remote", "voiceCancel", { id: a.sessionId });
  stopCapture(a);
  releaseMicrophone(a);
  clearTimeout(a.endTimer);
  set(IDLE);
}
