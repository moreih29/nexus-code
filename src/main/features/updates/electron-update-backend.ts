import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as electron from "electron";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "../../../shared/log/types";
import { isLinux, isMac } from "../../infra/platform";
import { updateFeedUrl } from "./feed-url";
import type { DownloadProgress, UpdateBackend } from "./installer";

const OWNER = "moreih29";
const REPO = "nexus-code";
const PACKAGE_MANAGER_ENV = "ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER";

export function canUpdateInPlace(): boolean {
  if (isMac()) return true;
  return isLinux() && (process.env.APPIMAGE !== undefined || isDebInstall());
}

function isDebInstall(): boolean {
  if (!isLinux()) return false;
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim() === "deb";
  } catch {
    return false;
  }
}

export function createElectronUpdateBackend(
  logger: Logger,
  { prepareRestart, beforeInstall }: { prepareRestart(): Promise<void>; beforeInstall(): void },
): UpdateBackend {
  const deb = isDebInstall();
  const stagedListeners: (() => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const progressListeners: ((progress: DownloadProgress) => void)[] = [];
  let loaded: Promise<AppUpdater> | null = null;

  function load(): Promise<AppUpdater> {
    loaded ??= Promise.resolve().then(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
      autoUpdater.logger = {
        info: (message) => logger.info(String(message)),
        warn: (message) => logger.warn(String(message)),
        error: (message) => logger.error(String(message)),
        debug: (message) => logger.debug(String(message)),
      };
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = !deb;
      const feed = updateFeedUrl(process.env.NEXUS_UPDATE_FEED_URL, (m) => logger.warn(m));
      autoUpdater.setFeedURL(
        feed
          ? { provider: "generic", url: feed }
          : { provider: "github", owner: OWNER, repo: REPO },
      );
      if (!isMac()) {
        autoUpdater.on("update-downloaded", () => {
          for (const listener of stagedListeners) listener();
        });
      }
      autoUpdater.on("error", (error: Error) => {
        for (const listener of errorListeners) listener(error);
      });
      autoUpdater.on("download-progress", ({ transferred, total, bytesPerSecond }) => {
        for (const listener of progressListeners) listener({ transferred, total, bytesPerSecond });
      });
      return autoUpdater;
    });
    return loaded;
  }

  if (isMac()) {
    electron.autoUpdater.on("update-downloaded", () => {
      for (const listener of stagedListeners) listener();
    });
  }

  return {
    installAsksForPassword: deb,
    async check(channel) {
      const updater = await load();
      updater.allowPrerelease = channel === "beta";
      const result = await updater.checkForUpdates();
      return result?.isUpdateAvailable ? result.updateInfo.version : null;
    },
    async download() {
      await (await load()).downloadUpdate();
    },
    onStaged(listener) {
      stagedListeners.push(listener);
    },
    onProgress(listener) {
      progressListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    prepareRestart,
    async quitAndInstall() {
      const updater = await load();
      beforeInstall();
      if (!deb) {
        updater.quitAndInstall();
        return;
      }
      process.env[PACKAGE_MANAGER_ENV] = "apt";
      try {
        updater.quitAndInstall();
      } finally {
        delete process.env[PACKAGE_MANAGER_ENV];
      }
    },
  };
}
