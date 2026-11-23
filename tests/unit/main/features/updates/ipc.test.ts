import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
} from "../../../../helpers/ipc-pair";
import { mainWarnMock } from "../../../../log-test-spies";

const openExternal = mock(async (_url: string) => {});

mock.module("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  shell: { openExternal },
}));

const { installUpdatesDomain } = await import("../../../../../src/main/features/updates");

beforeEach(() => {
  resetInMemoryIpc();
  openExternal.mockClear();
});
afterEach(resetInMemoryIpc);

async function updater() {
  await setupInMemoryRouter();
  installUpdatesDomain({
    currentVersion: "1.0.0",
    stateService: { getState: () => ({}), setState: () => {} } as never,
    broadcast: () => {},
  });
  return createIpcPair().window.ipc;
}

test("an update link that the system cannot open returns a recoverable error", async () => {
  const ipc = await updater();
  const failure = Promise.reject(new Error("The URL could not be opened"));
  void failure.catch(() => {});
  openExternal.mockImplementationOnce(() => failure);

  const result = await ipc.call("updates", "openReleasePage", {
    url: "https://release.example.test/app",
  });

  expect(result).toMatchObject({ ok: false, kind: "open-external-failed" });
});

test("a blocked update link does not log its contents", async () => {
  const ipc = await updater();
  const marker = "private-update-token";
  const logs = mainWarnMock.mock.calls.length;
  const result = await ipc.call("updates", "openReleasePage", {
    url: `data:text/plain,${marker}`,
  });

  expect(openExternal).not.toHaveBeenCalled();
  expect(JSON.stringify(mainWarnMock.mock.calls.slice(logs))).not.toContain(marker);
  expect(result).toMatchObject({ ok: false, kind: "invalid-args" });
});

test.each([
  "auto",
  "manual",
] as const)("an in-flight %s check cannot publish a version from an old channel", async (trigger) => {
  await setupInMemoryRouter();
  const beta = Promise.withResolvers<Response>();
  const stablePublished = Promise.withResolvers<void>();
  const broadcast = mock((_channel: string, _name: string, status: unknown) => {
    if (typeof status === "object" && status && "latest" in status && status.latest === "2.0.0")
      stablePublished.resolve();
  });
  let settings = { updateChannel: "beta", autoCheckForUpdates: trigger === "auto" };
  const stateService = {
    getState: () => settings,
    setState: (patch: Partial<typeof settings>) => {
      settings = { ...settings, ...patch };
    },
  };
  const domain = installUpdatesDomain({
    stateService: stateService as never,
    currentVersion: "1.0.0",
    broadcast,
    fetchImpl: async (url) =>
      String(url).endsWith(".atom") ? beta.promise : new Response("version: 2.0.0"),
    timerScheduler: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  if (trigger === "auto") domain.startAutoChecks();
  else domain.checkManual();
  stateService.setState({ updateChannel: "stable" });
  await stablePublished.promise;
  beta.resolve(new Response('<link href="https://example.test/releases/tag/v3.0.0-beta.1"/>'));
  await Bun.sleep(0);
  const status = await createIpcPair().window.ipc.call("updates", "getStatus", undefined);
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(status).toMatchObject({ ok: true, value: { status: { kind: "newer", latest: "2.0.0" } } });
});
