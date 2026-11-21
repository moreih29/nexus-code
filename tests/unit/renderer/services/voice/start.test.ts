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
  globals.window = {
    ipc: {
      async call(channel: string, method: string) {
        if (channel === "remote") calls.push(method);
        if (method === "account") return { status: signedIn ? "signed-in" : "signed-out" };
        if (method === "serverInfo") return { voice };
        if (method === "voiceMicrophone") return "granted";
        if (method === "voiceStart") {
          return { status: "started", id: "session", sampleRate: 8000, maxSeconds: 600 };
        }
        if (method === "readTranscript") return EMPTY_TRANSCRIPT;
        if (method === "voicePrint") return null;
      },
      listen: () => () => {},
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
