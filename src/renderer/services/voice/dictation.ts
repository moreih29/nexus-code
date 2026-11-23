import i18next from "i18next";
import { create } from "zustand";
import type { VoicePurpose } from "../../../../packages/remote-protocol/src/voice";
import {
  VOICE_CLOSE_SIGNED_OUT,
  type VoiceEvent,
  type VoiceFailure,
} from "../../../shared/remote/voice";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { voiceAvailability, voiceAvailabilityNow } from "./availability";
import { type Capture, CaptureError, openMicrophone, startCapture } from "./capture";

export const STOP_TIMEOUT_MS = 10_000;

export type DictationPhase = "idle" | "starting" | "listening" | "stopping";

export interface EndedDictation {
  owner: string;
  finals: string;
  partial: string;
  seq: number;
}

interface DictationState {
  phase: DictationPhase;
  owner: string | null;
  finals: string;
  partial: string;
  level: number;
  listeningSince: number | null;
  limitMs: number | null;
  ended: EndedDictation | null;
}

export const useDictationStore = create<DictationState>(() => ({
  phase: "idle",
  owner: null,
  finals: "",
  partial: "",
  level: 0,
  listeningSince: null,
  limitMs: null,
  ended: null,
}));

interface Session {
  owner: string;
  id: string | null;
  capture: Capture | null;
  revokedBeforeStart?: Set<string>;
  releaseStartingStream?: () => void;
  abandoned: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  levelTimer?: ReturnType<typeof setInterval>;
}

let session: Session | null = null;
let endedCount = 0;
let listening = false;

export function tellFailure(
  reason: VoiceFailure | CaptureError["reason"],
  purpose: VoicePurpose = "dictation",
): void {
  switch (reason) {
    case "signed-out":
      showToast({
        kind: "info",
        message:
          purpose === "note"
            ? i18next.t("notes:recorder.failure.signed-out")
            : i18next.t("common:voice.failure.signed-out"),
        actions: [
          {
            label: i18next.t("common:voice.signIn"),
            dedupeKey: "remote-settings",
            onAction: () => useSettingsUIStore.getState().openSettingsAt("remote"),
          },
        ],
      });
      return;
    case "denied":
      showToast({
        kind: "error",
        message: i18next.t("common:voice.failure.denied"),
        actions: [
          {
            label: i18next.t("common:voice.openSettings"),
            dedupeKey: "microphone-settings",
            onAction: () => void ipcCallResult("remote", "openMicrophoneSettings", undefined),
          },
        ],
      });
      return;
    case "outdated":
      showToast({
        kind: "error",
        message: i18next.t("common:voice.failure.outdated"),
        actions: [
          {
            label: i18next.t("common:voice.update"),
            dedupeKey: "remote-settings",
            onAction: () => useSettingsUIStore.getState().openSettingsAt("remote"),
          },
        ],
      });
      return;
    case "in-use":
      return;
    case "response-too-large":
      showToast({ kind: "error", message: i18next.t("common:voice.failure.failed") });
      return;
    default:
      showToast({ kind: "error", message: i18next.t(`common:voice.failure.${reason}`) });
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  ipcListen("remote", "voiceEvent", onEvent);
}

function onEvent({ id, event }: VoiceEvent): void {
  if (!session) return;
  if (session.id !== id) {
    if (event.t === "closed" && event.code === VOICE_CLOSE_SIGNED_OUT) {
      session.revokedBeforeStart?.add(id);
    }
    return;
  }
  switch (event.t) {
    case "partial":
      useDictationStore.setState({ partial: event.text });
      return;
    case "final":
      useDictationStore.setState((s) => ({ finals: s.finals + event.text, partial: "" }));
      return;
    case "limit":
      showToast({ kind: "info", message: i18next.t(`common:voice.limit.${event.reason}`) });
      stopDictation();
      return;
    case "error":
      if (event.code === "unauthorized") tellFailure("signed-out");
      else showToast({ kind: "error", message: i18next.t("common:voice.failure.recognition") });
      return;
    case "done":
    case "ready":
      return;
    case "closed": {
      const stopping = useDictationStore.getState().phase === "stopping";
      if (event.code === VOICE_CLOSE_SIGNED_OUT) tellFailure("signed-out");
      else if (event.code !== 1000 && !stopping) {
        showToast({ kind: "error", message: i18next.t("common:voice.failure.dropped") });
      }
      finish();
      return;
    }
  }
}

function finish(): void {
  const ending = session;
  if (!ending) return;
  session = null;
  ending.releaseStartingStream?.();
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

export async function toggleDictation(owner: string, language: string): Promise<void> {
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
    if (session !== mine) return;
    session = null;
    useDictationStore.setState({ phase: "idle", owner: null, finals: "", partial: "" });
    if (reason && !mine.abandoned) tellFailure(reason);
  };

  let availability = voiceAvailability();
  if (availability === "unknown") availability = await voiceAvailabilityNow();
  if (mine.abandoned) return giveUp();
  if (availability === "signed-out" || availability === "unavailable") return giveUp(availability);

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

  const revoked = new Set<string>();
  mine.revokedBeforeStart = revoked;
  const started = await ipcCallResult("remote", "voiceStart", { language });
  mine.revokedBeforeStart = undefined;
  if (!started.ok) {
    stopStream();
    return giveUp("failed");
  }
  if (started.value.status === "failed") {
    stopStream();
    return giveUp(started.value.reason);
  }
  const { id, sampleRate, maxSeconds } = started.value;
  if (revoked.has(id)) {
    stopStream();
    return giveUp("signed-out");
  }
  mine.id = id;
  if (mine.abandoned) {
    stopStream();
    void ipcCallResult("remote", "voiceCancel", { id });
    return giveUp();
  }
  mine.releaseStartingStream = stopStream;
  try {
    mine.capture = await startCapture(stream, sampleRate, (audio) => {
      if (session === mine) void ipcCallResult("remote", "voiceAudio", { id, audio });
    });
  } catch (error) {
    void ipcCallResult("remote", "voiceCancel", { id });
    return giveUp(error instanceof CaptureError ? error.reason : "failed");
  } finally {
    mine.releaseStartingStream = undefined;
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
  useDictationStore.setState({
    phase: "listening",
    listeningSince: Date.now(),
    limitMs: maxSeconds * 1000,
  });
}

export function stopDictation(): void {
  const current = session;
  if (!current) return;
  if (!current.id || !current.capture) {
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

interface Target {
  owner: string;
  toggle(): void;
}

const targets = new Map<string, Target>();
let lastFocused: string | null = null;

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
