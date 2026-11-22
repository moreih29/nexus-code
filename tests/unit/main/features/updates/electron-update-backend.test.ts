import { expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createElectronUpdateBackend } from "../../../../../src/main/features/updates/electron-update-backend";
import { createUpdateInstaller } from "../../../../../src/main/features/updates/installer";
import * as platform from "../../../../../src/main/infra/platform";

const updater = Object.assign(new EventEmitter(), {
  setFeedURL: () => {},
  checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "1.2.0" } }),
  downloadUpdate: async () => {
    updater.emit("update-downloaded");
  },
  quitAndInstall: mock(() => {}),
});
mock.module("electron-updater", () => ({ autoUpdater: updater }));

test.each([
  false,
  true,
])("prepares Linux windows and flushes main state before updater handoff (flush fails: %s)", async (fails) => {
  const linux = spyOn(platform, "isLinux").mockReturnValue(true);
  const mac = spyOn(platform, "isMac").mockReturnValue(false);
  const prepared = Promise.withResolvers<void>();
  const events: string[] = [];
  updater.quitAndInstall.mockImplementation(() => events.push("install"));
  try {
    const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    const backend = createElectronUpdateBackend(logger, {
      prepareRestart() {
        events.push("prepare windows");
        return prepared.promise;
      },
      beforeInstall() {
        events.push("flush state");
        if (fails) throw new Error("state write failed");
      },
    });
    const status = mock(() => {});
    const installer = createUpdateInstaller({
      backend,
      logger,
      onStatus: status,
      onProgress: () => {},
      releaseUrl: () => "releases",
    });
    await installer.install("stable");
    const restarting = installer.restart();
    expect(events).toEqual(["prepare windows"]);
    prepared.resolve();
    await restarting;
    expect(events).toEqual(
      fails ? ["prepare windows", "flush state"] : ["prepare windows", "flush state", "install"],
    );
    if (fails)
      expect(status).toHaveBeenLastCalledWith({ kind: "installFailed", releaseUrl: "releases" });
  } finally {
    updater.removeAllListeners();
    linux.mockRestore();
    mac.mockRestore();
  }
});
