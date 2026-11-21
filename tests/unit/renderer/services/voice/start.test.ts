import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import {
  dropRecording,
  startRecording,
  useRecorderStore,
} from "../../../../../src/renderer/services/notes/recorder";
import {
  flushTranscript,
  useTranscriptsStore,
} from "../../../../../src/renderer/services/notes/transcripts";
import * as availability from "../../../../../src/renderer/services/voice/availability";
import * as capture from "../../../../../src/renderer/services/voice/capture";
import {
  cancelDictation,
  focusedDictationTarget,
  registerDictationTarget,
  toggleDictation,
  toggleDictationByShortcut,
  useDictationStore,
} from "../../../../../src/renderer/services/voice/dictation";
import { useSettingsUIStore } from "../../../../../src/renderer/state/stores/settings-ui";
import { EMPTY_TRANSCRIPT } from "../../../../../src/shared/notes/transcript";
import { VOICE_CLOSE_SIGNED_OUT, type VoiceEvent } from "../../../../../src/shared/remote/voice";

const globals = globalThis as { window?: unknown };
const owner = "composer";
const workspaceId = "workspace";
const noteId = "voice-start";
const calls: string[] = [];
const toasts: ToastInput[] = [];

let previousWindow: unknown;
let previousTranscripts: ReturnType<typeof useTranscriptsStore.getState>;
let stopWatching: () => void;
let signedIn: boolean;
let voice: boolean;
let startSignedOut: boolean;
let startRateLimited: boolean;
let revokeBeforeReply: boolean;
let voiceEvent: ((payload: VoiceEvent) => void) | undefined;
let open: ReturnType<typeof spyOn<typeof capture, "openMicrophone">>;
let start: ReturnType<typeof spyOn<typeof capture, "startCapture">>;

beforeEach(() => {
  previousWindow = globals.window;
  previousTranscripts = useTranscriptsStore.getState();
  calls.length = 0;
  toasts.length = 0;
  stopWatching = watchToasts((toast) => toasts.push(toast));
  signedIn = true;
  voice = true;
  startSignedOut = false;
  startRateLimited = false;
  revokeBeforeReply = false;
  globals.window = {
    ipc: {
      async call(channel: string, method: string) {
        if (channel === "remote") calls.push(method);
        if (method === "account") return { status: signedIn ? "signed-in" : "signed-out" };
        if (method === "serverInfo") return { voice };
        if (method === "voiceMicrophone") return "granted";
        if (method === "voiceStart") {
          if (startSignedOut) return { status: "failed", reason: "signed-out" };
          if (startRateLimited) return { status: "failed", reason: "rate-limited" };
          if (revokeBeforeReply)
            voiceEvent?.({ id: "session", event: { t: "closed", code: VOICE_CLOSE_SIGNED_OUT } });
          return { status: "ready", id: "session", sampleRate: 8000, maxSeconds: 600 };
        }
        if (method === "readTranscript") return EMPTY_TRANSCRIPT;
        if (method === "voicePrint") return null;
      },
      listen(channel: string, name: string, listener: (payload: VoiceEvent) => void) {
        // Dictation keeps its first subscription for the life of the renderer.
        if (channel === "remote" && name === "voiceEvent") voiceEvent ??= listener;
        return () => {};
      },
    },
  };
  open = spyOn(capture, "openMicrophone").mockImplementation(async () => {
    calls.push("openMicrophone");
    return { getTracks: () => [] } as unknown as MediaStream;
  });
  start = spyOn(capture, "startCapture").mockImplementation(async () => {
    calls.push("startCapture");
    return { level: () => 0, stop() {} };
  });
});

afterEach(async () => {
  cancelDictation(owner);
  dropRecording(workspaceId, noteId);
  await flushTranscript(workspaceId, noteId);
  stopWatching();
  globals.window = previousWindow;
  useTranscriptsStore.setState(previousTranscripts);
  useSettingsUIStore.getState().closeSettings();
  open.mockRestore();
  start.mockRestore();
});

test("signed-out dictation via the shortcut checks unknown availability once and keeps the microphone off", async () => {
  signedIn = false;
  const cached = spyOn(availability, "voiceAvailability").mockReturnValueOnce("unknown");
  let started: Promise<void> | undefined;
  const remove = registerDictationTarget({
    owner,
    toggle: () => {
      started = toggleDictation(owner, "en");
    },
  });
  try {
    focusedDictationTarget(owner);
    expect(toggleDictationByShortcut()).toBe(true);
    await started;
    expect(calls).toEqual(["account"]);
    expect(open).not.toHaveBeenCalled();
    expect(useDictationStore.getState().phase).toBe("idle");
    expect(toasts.map((toast) => toast.message)).toEqual(["Sign in to use voice input."]);
    const action = toasts[0]?.actions?.[0];
    expect(action?.label).toBe("Sign in");
    action?.onAction();
    expect(useSettingsUIStore.getState().initialActiveId).toBe("remote");
  } finally {
    remove();
    cached.mockRestore();
  }
});

test("signed-out recording keeps the microphone off", async () => {
  signedIn = false;
  expect(await availability.voiceAvailabilityNow()).toBe("signed-out");
  calls.length = 0;
  await startRecording(workspaceId, noteId, "en");
  expect(calls).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  expect(useRecorderStore.getState().phase).toBe("idle");
  expect(toasts.map((toast) => toast.message)).toEqual(["Sign in to start recording."]);
  const action = toasts[0]?.actions?.[0];
  expect(action?.label).toBe("Sign in");
  action?.onAction();
  expect(useSettingsUIStore.getState().initialActiveId).toBe("remote");
});

test("a recording start refused by the server uses the recording sign-in toast", async () => {
  startSignedOut = true;
  expect(await availability.voiceAvailabilityNow()).toBe("ready");
  await startRecording(workspaceId, noteId, "en");
  expect(useRecorderStore.getState().phase).toBe("idle");
  expect(toasts.map((toast) => toast.message)).toEqual(["Sign in to start recording."]);
});

test("rate-limited dictation and recording show the retry message and leave capture stopped", async () => {
  startRateLimited = true;
  expect(await availability.voiceAvailabilityNow()).toBe("ready");
  await toggleDictation(owner, "en");
  await startRecording(workspaceId, noteId, "en");
  expect(useDictationStore.getState().phase).toBe("idle");
  expect(useRecorderStore.getState().phase).toBe("idle");
  expect(start).not.toHaveBeenCalled();
  expect(toasts.map((toast) => toast.message)).toEqual([
    "Too many voice requests. Try again in a moment.",
    "Too many voice requests. Try again in a moment.",
  ]);
});

test.each([false, true])("4001 ends dictation with early close=%p", async (early) => {
  revokeBeforeReply = early;
  expect(await availability.voiceAvailabilityNow()).toBe("ready");
  const stopTrack = spyOn({ stop() {} }, "stop");
  const running = { level: () => 0, stop() {} };
  const stop = spyOn(running, "stop");
  open.mockResolvedValueOnce({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  start.mockResolvedValueOnce(running);
  await toggleDictation(owner, "en");
  if (!early) {
    expect(useDictationStore.getState().phase).toBe("listening");
    voiceEvent?.({ id: "session", event: { t: "final", text: "kept text" } });
    voiceEvent?.({ id: "session", event: { t: "closed", code: VOICE_CLOSE_SIGNED_OUT } });
    expect(useDictationStore.getState().ended?.finals).toBe("kept text");
  }
  expect(useDictationStore.getState().phase).toBe("idle");
  expect(stop).toHaveBeenCalledTimes(early ? 0 : 1);
  expect(stopTrack).toHaveBeenCalledTimes(early ? 1 : 0);
  expect(calls.filter((call) => call === "voiceStart")).toHaveLength(1);
  expect(toasts.map((toast) => toast.message)).toEqual(["Sign in to use voice input."]);
});

test("a server without voice stops dictation and recording before microphone access", async () => {
  voice = false;
  expect(await availability.voiceAvailabilityNow()).toBe("unavailable");
  calls.length = 0;
  await toggleDictation(owner, "en");
  await startRecording(workspaceId, noteId, "en");
  expect(calls).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  expect(toasts).toHaveLength(2);
  expect(toasts.every((toast) => toast.kind === "error")).toBe(true);
});

test("ready dictation and recording start in the usual order using cached availability", async () => {
  expect(await availability.voiceAvailabilityNow()).toBe("ready");
  calls.length = 0;
  const startCalls = ["voiceMicrophone", "openMicrophone", "voiceStart", "startCapture"];
  await toggleDictation(owner, "en");
  expect(useDictationStore.getState().phase).toBe("listening");
  expect(calls).toEqual(startCalls);
  cancelDictation(owner);

  calls.length = 0;
  await startRecording(workspaceId, noteId, "en");
  expect(useRecorderStore.getState().phase).toBe("recording");
  expect(calls).toEqual(startCalls);
  expect(toasts).toEqual([]);
});
