/**
 * initUpdatesSubscriptions — the toasts of an update, the calls their
 * actions make, and the status it hands the updates store. A newer version
 * the app found by itself is toasted once; its download and restart are
 * left to the title bar's update button. The real ipc client and toast
 * modules are spread under spies so later files keep their other exports.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

type Status = Record<string, unknown> & { kind: string };

const toasts: ToastInput[] = [];
const dismissed: number[] = [];
const calls: { method: string; args: unknown }[] = [];
let emit: (status: Status) => void = () => {};
let emitProgress: (progress: Record<string, unknown>) => void = () => {};
/** What `updates.getStatus` answers: the status before the window listened. */
let before: Status | null = null;

const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: ToastInput) => toasts.push(input),
  dismissToast: (id: number) => {
    dismissed.push(id);
  },
}));
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: (_channel: string, event: string, callback: (payload: never) => void) => {
    if (event === "progress") emitProgress = callback;
    else emit = callback;
    return () => {};
  },
  ipcCallResult: (_channel: string, method: string, args: unknown) => {
    if (method === "getStatus") {
      return Promise.resolve({ ok: true, value: { status: before, progress: null } });
    }
    calls.push({ method, args });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { initUpdatesSubscriptions } = await import(
  "../../../../../src/renderer/state/operations/updates"
);
const { useUpdatesStore } = await import("../../../../../src/renderer/state/stores/updates");

const newer = (latest: string, canInstall: boolean, trigger = "auto"): Status => ({
  kind: "newer",
  trigger,
  current: "1.0.0",
  latest,
  releaseUrl: `https://example.invalid/releases/tag/v${latest}`,
  canInstall,
});

beforeAll(() => {
  initUpdatesSubscriptions();
});

beforeEach(() => {
  toasts.length = 0;
  dismissed.length = 0;
  calls.length = 0;
  useUpdatesStore.setState({
    status: null,
    progress: null,
    ignoredVersion: null,
    announcedVersion: null,
  });
});

const actionCalls = () => calls.filter((call) => call.method !== "set");

describe("initUpdatesSubscriptions", () => {
  it("offers an in-place update when the app can install one", () => {
    emit(newer("1.1.0", true));
    toasts[0]?.actions?.[0]?.onAction();

    expect(toasts[0]?.actions).toHaveLength(2);
    expect(actionCalls()).toEqual([{ method: "install", args: undefined }]);
  });

  it("offers the release page when the app cannot install in place", () => {
    emit(newer("1.2.0", false));
    toasts[0]?.actions?.[0]?.onAction();

    expect(actionCalls()).toEqual([
      { method: "openReleasePage", args: { url: "https://example.invalid/releases/tag/v1.2.0" } },
    ]);
  });

  it("toasts a version the app found by itself once, and keeps which in AppState", () => {
    emit(newer("1.3.0", true));
    emit(newer("1.3.0", true));
    useUpdatesStore.setState({ status: null });
    emit(newer("1.3.0", true));

    expect(toasts).toHaveLength(1);
    expect(useUpdatesStore.getState().announcedVersion).toBe("1.3.0");
    expect(calls).toEqual([{ method: "set", args: { announcedUpdateVersion: "1.3.0" } }]);
  });

  it("does not toast a version told of before a restart, nor one skipped", () => {
    useUpdatesStore.setState({ announcedVersion: "1.4.0", ignoredVersion: "1.5.0" });
    emit(newer("1.4.0", true));
    emit(newer("1.5.0", true));

    expect(toasts).toHaveLength(0);
    expect(useUpdatesStore.getState().status).toMatchObject({ kind: "newer", latest: "1.5.0" });
  });

  it("answers a check the user asked for, told of before or not", () => {
    useUpdatesStore.setState({ announcedVersion: "1.4.0" });
    emit(newer("1.4.0", true, "manual"));

    expect(toasts).toHaveLength(1);
  });

  it("skips a version from its toast, for the title bar too", () => {
    emit(newer("1.6.0", true));
    toasts[0]?.actions?.[1]?.onAction();

    expect(useUpdatesStore.getState().ignoredVersion).toBe("1.6.0");
    expect(actionCalls()).toEqual([{ method: "setIgnoredVersion", args: { version: "1.6.0" } }]);
  });

  it("leaves the download and the restart to the title bar's button", () => {
    emit({ kind: "downloading", version: "1.1.0" });
    const progress = { version: "1.1.0", transferred: 40, total: 100, bytesPerSecond: 20 };
    emitProgress(progress);
    emit({ kind: "verifying", version: "1.1.0" });
    emit({ kind: "ready", version: "1.1.0" });

    expect(toasts).toHaveLength(0);
    expect(dismissed).toEqual([]);
    expect(useUpdatesStore.getState().status).toEqual({ kind: "ready", version: "1.1.0" });
  });

  it("hands every status to the store, toast or not", () => {
    emit({ kind: "current", trigger: "auto", current: "1.0.0" });
    emit({ kind: "verifying", version: "1.1.0" });

    expect(toasts).toHaveLength(0);
    expect(useUpdatesStore.getState().status).toEqual({ kind: "verifying", version: "1.1.0" });
  });

  it("tells of a newer version found before the window listened, once", async () => {
    before = newer("1.7.0", true);
    initUpdatesSubscriptions();
    await Promise.resolve();
    useUpdatesStore.setState({ status: null });
    initUpdatesSubscriptions();
    await Promise.resolve();
    before = null;

    expect(toasts).toHaveLength(1);
    expect(useUpdatesStore.getState().status).toMatchObject({ kind: "newer", latest: "1.7.0" });
  });

  it("links the release page from a failed install", () => {
    emit({ kind: "installFailed", releaseUrl: "https://example.invalid/releases" });
    toasts[0]?.actions?.[0]?.onAction();

    expect(toasts[0]?.kind).toBe("error");
    expect(calls).toEqual([
      { method: "openReleasePage", args: { url: "https://example.invalid/releases" } },
    ]);
  });
});
