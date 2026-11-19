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
  // The fixture's rejected work is observed even if the handler ignores it.
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
