/**
 * initUpdatesSubscriptions — the toasts of an update and the calls their
 * actions make. The real ipc client and toast modules are spread under spies
 * so later files keep their other exports.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

type Status = Record<string, unknown> & { kind: string };

const toasts: ToastInput[] = [];
const calls: { method: string; args: unknown }[] = [];
let emit: (status: Status) => void = () => {};

const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: ToastInput) => {
    toasts.push(input);
  },
}));
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: (_channel: string, _event: string, callback: (status: Status) => void) => {
    emit = callback;
    return () => {};
  },
  ipcCallResult: (_channel: string, method: string, args: unknown) => {
    calls.push({ method, args });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { initUpdatesSubscriptions } = await import(
  "../../../../../src/renderer/state/operations/updates"
);

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
  calls.length = 0;
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

  it("restarts into a staged update from its toast", () => {
    emit({ kind: "ready", version: "1.1.0" });
    toasts[0]?.actions?.[0]?.onAction();

    expect(calls).toEqual([{ method: "restart", args: undefined }]);
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
