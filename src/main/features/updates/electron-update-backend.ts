/**
 * electron-updater as the installer's UpdateBackend.
 *
 * electron-updater downloads the release file named in the platform's feed
 * file (latest-mac.yml, latest-linux.yml) and checks its sha512.
 *
 * - macOS: the zip goes to Squirrel.Mac, which verifies its code signature and
 *   stages it. electron-updater's own update-downloaded event fires before that
 *   verification, so the backend reports a staged update on Squirrel.Mac's
 *   event instead.
 * - Linux: the new AppImage is staged once downloaded and replaces the running
 *   one on quit. A deb install has no file the app can replace; the package
 *   manager updates it.
 *
 * NEXUS_UPDATE_FEED_URL points the updater at a generic feed — a directory
 * holding the feed file and the release file — to try an update without
 * publishing a release. Squirrel.Mac still requires the release signature.
 */

import { autoUpdater as nativeUpdater } from "electron";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "../../../shared/log/types";
import type { UpdateBackend } from "./installer";

const OWNER = "moreih29";
const REPO = "nexus-code";

/** Whether this install can replace itself: a macOS app or a Linux AppImage. */
export function canUpdateInPlace(): boolean {
  if (process.platform === "darwin") return true;
  return process.platform === "linux" && process.env.APPIMAGE !== undefined;
}

export function createElectronUpdateBackend(logger: Logger): UpdateBackend {
  const stagedListeners: (() => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  let loaded: Promise<AppUpdater> | null = null;

  // Loaded on first use: most sessions never install an update. A plain
  // require: electron-updater exports autoUpdater as a getter, which the
  // bundler's namespace wrapper for import() leaves out.
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
      // A staged update the user does not restart for goes in at the next quit.
      autoUpdater.autoInstallOnAppQuit = true;
      const feed = process.env.NEXUS_UPDATE_FEED_URL;
      autoUpdater.setFeedURL(
        feed
          ? { provider: "generic", url: feed }
          : { provider: "github", owner: OWNER, repo: REPO },
      );
      if (process.platform !== "darwin") {
        autoUpdater.on("update-downloaded", () => {
          for (const listener of stagedListeners) listener();
        });
      }
      autoUpdater.on("error", (error: Error) => {
        for (const listener of errorListeners) listener(error);
      });
      return autoUpdater;
    });
    return loaded;
  }

  if (process.platform === "darwin") {
    nativeUpdater.on("update-downloaded", () => {
      for (const listener of stagedListeners) listener();
    });
  }

  return {
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
    onError(listener) {
      errorListeners.push(listener);
    },
    quitAndInstall() {
      void load().then((updater) => updater.quitAndInstall());
    },
  };
}
