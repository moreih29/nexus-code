/**
 * Voice input, one dictation at a time across the window: the microphone
 * is captured here and sent to main's voice socket, and what the server
 * hears comes back as finals and a partial, kept in this store for the
 * composer that owns the dictation to show. When the dictation ends, its
 * text stays with that composer (`ended`); nothing is ever sent for the
 * user. Failures are told in a toast.
 */

import i18next from "i18next";
import { create } from "zustand";
import type { VoiceEvent, VoiceFailure } from "../../../shared/remote/voice";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { type Capture, CaptureError, openMicrophone, startCapture } from "./capture";

/** How long after stopping the rest of the text may take before the dictation ends anyway. */
export const STOP_TIMEOUT_MS = 10_000;

export type DictationPhase = "idle" | "starting" | "listening" | "stopping";

/** A finished dictation's text, for its owner to keep. */
export interface EndedDictation {
  owner: string;
  finals: string;
  partial: string;
  /** Counts endings, so the same text twice is still seen as new. */
  seq: number;
}

interface DictationState {
  phase: DictationPhase;
  /** The composer dictated into. */
  owner: string | null;
  finals: string;
  partial: string;
  /** How loud the microphone is, 0 to 1, while listening. */
  level: number;
  ended: EndedDictation | null;
}

export const useDictationStore = create<DictationState>(() => ({
  phase: "idle",
  owner: null,
  finals: "",
  partial: "",
  level: 0,
  ended: null,
}));

interface Session {
  owner: string;
  id: string | null;
  capture: Capture | null;
  /** Stopped (or dropped) while still starting: the start undoes itself. */
  abandoned: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  levelTimer?: ReturnType<typeof setInterval>;
}

let session: Session | null = null;
let endedCount = 0;
let listening = false;

const t = (key: string, options?: Record<string, unknown>) =>
  i18next.t(`common:voice.${key}`, options ?? {});

/** Tells why voice input did not start or stopped, with the way out where there is one. */
export function tellFailure(reason: VoiceFailure | CaptureError["reason"]): void {
  switch (reason) {
    case "signed-out":
      showToast({
        kind: "info",
        message: t("failure.signed-out"),
        actions: [
          {
            label: t("signIn"),
            onAction: () => useSettingsUIStore.getState().openSettingsAt("remote"),
          },
        ],
      });
      return;
    case "denied":
      showToast({
        kind: "error",
        message: t("failure.denied"),
        actions: [
          {
            label: t("openSettings"),
            onAction: () => void ipcCallResult("remote", "openMicrophoneSettings", undefined),
          },
        ],
      });
      return;
    case "in-use":
      return;
    default:
      showToast({ kind: "error", message: t(`failure.${reason}`) });
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  ipcListen("remote", "voiceEvent", onEvent);
}

function onEvent({ id, event }: VoiceEvent): void {
  if (!session || session.id !== id) return;
  switch (event.t) {
    case "partial":
      useDictationStore.setState({ partial: event.text });
      return;
    case "final":
      useDictationStore.setState((s) => ({ finals: s.finals + event.text, partial: "" }));
      return;
    case "limit":
      showToast({ kind: "info", message: t(`limit.${event.reason}`) });
      stopDictation();
      return;
    case "error":
      if (event.code === "unauthorized") tellFailure("signed-out");
      else showToast({ kind: "error", message: t("failure.recognition") });
      return;
    case "done":
    case "ready":
      return;
    case "closed": {
      const stopping = useDictationStore.getState().phase === "stopping";
      // 4001: the sign-in ended. Anything but a finished session while still listening: it dropped.
      if (event.code === 4001) tellFailure("signed-out");
      else if (event.code !== 1000 && !stopping) {
        showToast({ kind: "error", message: t("failure.dropped") });
      }
      finish();
      return;
    }
  }
}

/** Ends the dictation: its text stays with its owner. */
function finish(): void {
  const ending = session;
  if (!ending) return;
  session = null;
  ending.capture?.stop();
  clearTimeout(ending.stopTimer);
  clearInterval(ending.levelTimer);
  const { finals, partial } = useDictationStore.getState();
  endedCount += 1;
  useDictationStore.setState({
    phase: "idle",
    owner: null,
    finals: "",
    partial: "",
    level: 0,
    ended: { owner: ending.owner, finals, partial, seq: endedCount },
  });
}

/**
 * Starts dictating into `owner` in `language`; while one dictation runs,
 * any click stops it.
 */
export async function toggleDictation(owner: string, language: string): Promise<void> {
  // One at a time: a click anywhere while one runs stops it, its text kept where it was.
  if (session) {
    stopDictation();
    return;
  }
  await startDictation(owner, language);
}

async function startDictation(owner: string, language: string): Promise<void> {
  listen();
  const mine: Session = { owner, id: null, capture: null, abandoned: false };
  session = mine;
  useDictationStore.setState({ phase: "starting", owner, finals: "", partial: "", level: 0 });
  const giveUp = (reason?: VoiceFailure | CaptureError["reason"]) => {
    if (session === mine) {
      session = null;
      useDictationStore.setState({ phase: "idle", owner: null, finals: "", partial: "" });
    }
    if (reason && !mine.abandoned) tellFailure(reason);
  };

  const access = await ipcCallResult("remote", "voiceMicrophone", undefined);
  if (!access.ok || access.value === "denied") return giveUp("denied");
  let stream: MediaStream;
  try {
    stream = await openMicrophone();
  } catch (error) {
    return giveUp(error instanceof CaptureError ? error.reason : "failed");
  }
  const stopStream = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  if (mine.abandoned) {
    stopStream();
    return giveUp();
  }

  const started = await ipcCallResult("remote", "voiceStart", { language });
  if (!started.ok) {
    stopStream();
    return giveUp("failed");
  }
  if (started.value.status === "failed") {
    stopStream();
    return giveUp(started.value.reason);
  }
  const { id, sampleRate } = started.value;
  mine.id = id;
  if (mine.abandoned) {
    stopStream();
    void ipcCallResult("remote", "voiceCancel", { id });
    return giveUp();
  }
  try {
    mine.capture = await startCapture(stream, sampleRate, (audio) => {
      void ipcCallResult("remote", "voiceAudio", { id, audio });
    });
  } catch (error) {
    void ipcCallResult("remote", "voiceCancel", { id });
    return giveUp(error instanceof CaptureError ? error.reason : "failed");
  }
  if (mine.abandoned || session !== mine) {
    mine.capture.stop();
    void ipcCallResult("remote", "voiceCancel", { id });
    return giveUp();
  }
  mine.levelTimer = setInterval(() => {
    if (session === mine && mine.capture)
      useDictationStore.setState({ level: mine.capture.level() });
  }, 100);
  useDictationStore.setState({ phase: "listening" });
}

/**
 * Stops listening: the microphone goes off at once, and the server sends
 * the rest of the text before the dictation ends.
 */
export function stopDictation(): void {
  const current = session;
  if (!current) return;
  if (!current.id || !current.capture) {
    // Still starting: the start undoes itself when it comes back.
    current.abandoned = true;
    session = null;
    useDictationStore.setState({ phase: "idle", owner: null, finals: "", partial: "" });
    return;
  }
  if (useDictationStore.getState().phase === "stopping") return;
  current.capture.stop();
  clearInterval(current.levelTimer);
  useDictationStore.setState({ phase: "stopping", level: 0 });
  void ipcCallResult("remote", "voiceStop", { id: current.id });
  current.stopTimer = setTimeout(() => {
    if (session === current) {
      if (current.id) void ipcCallResult("remote", "voiceCancel", { id: current.id });
      finish();
    }
  }, STOP_TIMEOUT_MS);
}

/** Drops the dictation of `owner` (its composer went away): what was heard is lost. */
export function cancelDictation(owner: string): void {
  const current = session;
  if (!current || current.owner !== owner) return;
  if (current.id) void ipcCallResult("remote", "voiceCancel", { id: current.id });
  current.abandoned = true;
  current.capture?.stop();
  clearTimeout(current.stopTimer);
  clearInterval(current.levelTimer);
  session = null;
  useDictationStore.setState({ phase: "idle", owner: null, finals: "", partial: "", level: 0 });
}

// ---------------------------------------------------------------------------
// The shortcut's target: the composer focused last
// ---------------------------------------------------------------------------

interface Target {
  owner: string;
  toggle(): void;
}

const targets = new Map<string, Target>();
let lastFocused: string | null = null;

/** A composer that can be dictated into, for the shortcut; returns its removal. */
export function registerDictationTarget(target: Target): () => void {
  targets.set(target.owner, target);
  return () => {
    targets.delete(target.owner);
    if (lastFocused === target.owner) lastFocused = null;
  };
}

export function focusedDictationTarget(owner: string): void {
  lastFocused = owner;
}

/** The shortcut: stops the dictation running, or starts one in the composer focused last. */
export function toggleDictationByShortcut(): boolean {
  if (session) {
    stopDictation();
    return true;
  }
  const target = lastFocused ? targets.get(lastFocused) : undefined;
  if (!target) return false;
  target.toggle();
  return true;
}
