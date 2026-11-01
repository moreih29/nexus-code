/**
 * initUpdatesSubscriptions — the toasts of an update, the calls their
 * actions make, and the status it hands the updates store. The real ipc
 * client and toast modules are spread under spies so later files keep their
 * other exports.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

type Status = Record<string, unknown> & { kind: string };

const toasts: ToastInput[] = [];
const dismissed: number[] = [];
const calls: { method: string; args: unknown }[] = [];
let emit: (status: Status) => void = () => {};
let emitProgress: (progress: Record<string, unknown>) => void = () => {};

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
      return Promise.resolve({ ok: true, value: { status: null, progress: null } });
    }
    calls.push({ method, args });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { initUpdatesSubscriptions } = await import(
  "../../../../../src/renderer/state/operations/updates"
);
const { useSettingsUIStore } = await import("../../../../../src/renderer/state/stores/settings-ui");
const { useUpdatesStore } = await import("../../../../../src/renderer/state/stores/updates");

const newer = (latest: string, canInstall: boolean): Status => ({
  kind: "newer",
  trigger: "auto",
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
  useUpdatesStore.setState({ status: null, progress: null });
});

describe("initUpdatesSubscriptions", () => {
  it("offers an in-place update when the app can install one", () => {
    emit(newer("1.1.0", true));
    toasts[0]?.actions?.[0]?.onAction();

    expect(toasts[0]?.actions).toHaveLength(2);
    expect(calls).toEqual([{ method: "install", args: undefined }]);
  });

  it("offers the release page when the app cannot install in place", () => {
    emit(newer("1.2.0", false));
    toasts[0]?.actions?.[0]?.onAction();

    expect(calls).toEqual([
      { method: "openReleasePage", args: { url: "https://example.invalid/releases/tag/v1.2.0" } },
    ]);
  });

  it("points the download's toast at its progress in Settings › About", () => {
    emit({ kind: "downloading", version: "1.1.0" });
    const progress = { version: "1.1.0", transferred: 40, total: 100, bytesPerSecond: 20 };
    emitProgress(progress);
    toasts[0]?.actions?.[0]?.onAction();

    expect(useUpdatesStore.getState().progress).toEqual(progress);
    expect(useSettingsUIStore.getState()).toMatchObject({
      settingsOpen: true,
      initialActiveId: "about",
    });
  });

  it("takes the download's toast down once the download moves on, not for a check", () => {
    emit({ kind: "downloading", version: "1.1.0" });
    // An earlier test's download toast goes when this one comes.
    dismissed.length = 0;
    emit({ kind: "current", trigger: "manual", current: "1.0.0" });
    expect(dismissed).toEqual([]);

    emit({ kind: "verifying", version: "1.1.0" });
    expect(dismissed).toEqual([1]);
  });

  it("hands every status to the store, toast or not", () => {
    emit({ kind: "current", trigger: "auto", current: "1.0.0" });
    emit({ kind: "verifying", version: "1.1.0" });

    expect(toasts).toHaveLength(0);
    expect(useUpdatesStore.getState().status).toEqual({ kind: "verifying", version: "1.1.0" });
  });

  it("restarts into a staged update from its toast", () => {
    emit({ kind: "ready", version: "1.1.0" });
    toasts[0]?.actions?.[0]?.onAction();

    expect(calls).toEqual([{ method: "restart", args: undefined }]);
  });

  it("tells the user a deb's install asks for the admin password", () => {
    emit({ kind: "ready", version: "1.1.0", asksForPassword: true });
    emit({ kind: "ready", version: "1.2.0" });

    expect(toasts[0]?.message).toContain("admin password");
    expect(toasts[1]?.message).not.toContain("admin password");
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
