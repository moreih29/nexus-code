import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

type Status = Record<string, unknown> & { kind: string };

const toasts: ToastInput[] = [];
const visible = new Map<number, ToastInput>();
let nextToastId = 1;
const calls: { method: string; args: unknown }[] = [];
let emit: (status: Status) => void = () => {};
let before: Status | null = null;
let installFails = false;
let checkFails = false;

const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: ToastInput) => {
    const id = nextToastId++;
    toasts.push(input);
    visible.set(id, input);
    return id;
  },
  dismissToast: (id: number) => visible.delete(id),
}));
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: (_channel: string, event: string, callback: (payload: never) => void) => {
    if (event !== "progress") emit = callback;
    return () => {};
  },
  ipcCallResult: (_channel: string, method: string, args: unknown) => {
    if (method === "getStatus") {
      return Promise.resolve({ ok: true, value: { status: before, progress: null } });
    }
    calls.push({ method, args });
    if ((method === "install" && installFails) || (method === "check" && checkFails)) {
      return Promise.resolve({ ok: false, error: { code: "INTERNAL", message: "gone" } });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const i18next = (await import("i18next")).default;
const { checkForUpdates, initUpdatesSubscriptions, installUpdate } = await import(
  "../../../../../src/renderer/services/updates/operations"
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
  visible.clear();
  calls.length = 0;
  installFails = false;
  checkFails = false;
  useUpdatesStore.setState({
    status: null,
    progress: null,
    checking: false,
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

  it("shows the download the moment the user asks for it, before main has looked the version up", () => {
    emit(newer("1.1.0", true));
    toasts[0]?.actions?.[0]?.onAction();

    expect(useUpdatesStore.getState().status).toEqual({ kind: "downloading", version: "1.1.0" });
  });

  it("keeps the download shown while a check comes in, and gives way to main's own steps", () => {
    emit(newer("1.1.0", true));
    installUpdate("1.1.0");
    emit(newer("1.1.0", true));
    expect(useUpdatesStore.getState().status).toMatchObject({ kind: "downloading" });

    emit({ kind: "installFailed", releaseUrl: "https://example.invalid/releases" });
    expect(useUpdatesStore.getState().status).toMatchObject({ kind: "installFailed" });
  });

  it("puts back the offer when main never took the call", async () => {
    installFails = true;
    emit(newer("1.1.0", true));
    installUpdate("1.1.0");
    await Promise.resolve();

    expect(useUpdatesStore.getState().status).toMatchObject({ kind: "newer", latest: "1.1.0" });
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

  it("replaces older offers and uses the same slot for manual check feedback", () => {
    emit(newer("2.1.0", false));
    emit(newer("2.2.0", false));

    const offers = [...visible.values()];
    expect(offers.map((toast) => toast.message)).toEqual([toasts.at(-1)?.message ?? ""]);
    offers[0]?.actions?.[0]?.onAction();
    expect(actionCalls()).toEqual([
      { method: "openReleasePage", args: { url: "https://example.invalid/releases/tag/v2.2.0" } },
    ]);

    emit({ kind: "checking", trigger: "manual" });
    expect([...visible.values()]).toEqual([toasts.at(-1)]);
    expect(toasts.at(-1)?.actions).toBeUndefined();
    emit({ kind: "current", trigger: "manual", current: "2.2.0" });
    expect([...visible.values()]).toEqual([toasts.at(-1)]);
  });

  it("skips a version from its toast, for the title bar too", () => {
    emit(newer("1.6.0", true));
    toasts[0]?.actions?.[1]?.onAction();

    expect(useUpdatesStore.getState().ignoredVersion).toBe("1.6.0");
    expect(actionCalls()).toEqual([{ method: "setIgnoredVersion", args: { version: "1.6.0" } }]);
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
});

describe("a check while an update is offered or under way", () => {
  const ready = { kind: "ready", version: "1.1.0" } as const;
  const readyText = () => i18next.t("common:updates.ready", { version: "1.1.0" });

  it("answers a staged update with the restart, never with up to date", () => {
    useUpdatesStore.setState({ status: ready });
    emit({ kind: "current", trigger: "manual", current: "1.0.0", latest: "1.0.0" });

    expect(useUpdatesStore.getState().status).toEqual(ready);
    expect(toasts.map((toast) => toast.message)).toEqual([readyText()]);
    toasts[0]?.actions?.[0]?.onAction();
    expect(actionCalls()).toEqual([{ method: "restart", args: undefined }]);
  });

  it("answers the staged version found again with the restart, not a second offer", () => {
    useUpdatesStore.setState({ status: ready });
    emit(newer("1.1.0", true, "manual"));

    expect(useUpdatesStore.getState().status).toEqual(ready);
    expect(toasts.map((toast) => toast.message)).toEqual([readyText()]);
  });

  it("says a version past the staged one is on its way when the user asked", () => {
    useUpdatesStore.setState({ status: ready });
    emit(newer("1.2.0", true, "manual"));

    expect(toasts.map((toast) => toast.message)).toEqual([
      i18next.t("common:updates.downloading", { version: "1.2.0" }),
    ]);
    expect(toasts[0]?.actions).toBeUndefined();
  });

  it("offers a version past the staged one that the app found by itself", () => {
    useUpdatesStore.setState({ status: ready });
    emit(newer("1.2.0", true));
    toasts[0]?.actions?.[0]?.onAction();

    expect(actionCalls()).toEqual([{ method: "install", args: undefined }]);
  });

  it("answers a check during a download with the download", () => {
    useUpdatesStore.setState({ status: { kind: "downloading", version: "1.1.0" } });
    emit(newer("1.2.0", true, "manual"));

    expect(toasts.map((toast) => toast.message)).toEqual([
      i18next.t("common:updates.downloading", { version: "1.1.0" }),
    ]);
  });

  it("keeps an offer in place while its check runs, and marks the check", () => {
    emit(newer("1.1.0", true));
    checkForUpdates();
    expect(useUpdatesStore.getState()).toMatchObject({
      checking: true,
      status: { kind: "newer", latest: "1.1.0" },
    });
    expect(actionCalls()).toEqual([{ method: "check", args: { trigger: "manual" } }]);

    emit(newer("1.2.0", true, "manual"));
    expect(useUpdatesStore.getState()).toMatchObject({
      checking: false,
      status: { kind: "newer", latest: "1.2.0" },
    });
  });

  it("marks a check started from the menu once main says it runs", () => {
    useUpdatesStore.setState({ status: ready });
    emit({ kind: "checking", trigger: "manual" });
    expect(useUpdatesStore.getState()).toMatchObject({ checking: true, status: ready });

    emit(ready);
    expect(useUpdatesStore.getState().checking).toBe(false);
  });

  it("ends a check main never took", async () => {
    checkFails = true;
    checkForUpdates();
    await Promise.resolve();

    expect(useUpdatesStore.getState()).toMatchObject({ checking: false, status: null });
  });
});
