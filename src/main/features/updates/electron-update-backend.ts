/**
 * electron-updater as the installer's UpdateBackend.
 *
 * electron-updater downloads the release zip, checks it against the sha512 in
 * latest-mac.yml and serves it to Squirrel.Mac, which verifies its code
 * signature and stages it. electron-updater's own update-downloaded event fires
 * before that verification, so the backend reports a staged update on
 * Squirrel.Mac's event instead.
 *
 * NEXUS_UPDATE_FEED_URL points the updater at a generic feed — a directory
 * holding latest-mac.yml and the zip — to try an update without publishing a
 * release. Squirrel.Mac still requires the release signature.
 */

import { autoUpdater as nativeUpdater } from "electron";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "../../../shared/log/types";
import type { UpdateBackend } from "./installer";

const OWNER = "moreih29";
const REPO = "nexus-code";

export function createElectronUpdateBackend(logger: Logger): UpdateBackend {
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
      autoUpdater.on("error", (error: Error) => {
        for (const listener of errorListeners) listener(error);
      });
      return autoUpdater;
    });
    return loaded;
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
      nativeUpdater.on("update-downloaded", () => listener());
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    quitAndInstall() {
      void load().then((updater) => updater.quitAndInstall());
    },
  };
}
