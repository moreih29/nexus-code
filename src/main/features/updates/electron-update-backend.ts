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
 *   one on quit. A deb install downloads the next deb, which apt installs
 *   through pkexec when the user restarts; it is not installed on a plain
 *   quit, which would ask for the admin password then.
 *
 * NEXUS_UPDATE_FEED_URL points the updater at a generic feed — a directory
 * holding the feed file and the release file — to try an update without
 * publishing a release. Squirrel.Mac still requires the release signature.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater as nativeUpdater } from "electron";
import type { AppUpdater } from "electron-updater";
import type { Logger } from "../../../shared/log/types";
import type { UpdateBackend } from "./installer";

const OWNER = "moreih29";
const REPO = "nexus-code";
/** Picks the package manager electron-updater installs a deb with. */
const PACKAGE_MANAGER_ENV = "ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER";

/** Whether this install can replace itself: a macOS app, a Linux AppImage or a deb. */
export function canUpdateInPlace(): boolean {
  if (process.platform === "darwin") return true;
  return process.platform === "linux" && (process.env.APPIMAGE !== undefined || isDebInstall());
}

/**
 * Whether this is a deb install. electron-builder marks one with a
 * resources/package-type file, which electron-updater reads to pick its deb
 * updater.
 */
function isDebInstall(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim() === "deb";
  } catch {
    return false;
  }
}

export function createElectronUpdateBackend(logger: Logger): UpdateBackend {
  const deb = isDebInstall();
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
      // A staged update the user does not restart for goes in at the next quit,
      // except a deb, whose install asks for the admin password.
      autoUpdater.autoInstallOnAppQuit = !deb;
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
    onError(listener) {
      errorListeners.push(listener);
    },
    quitAndInstall() {
      void load().then((updater) => {
        if (!deb) {
          updater.quitAndInstall();
          return;
        }
        // One apt command installs the deb and any dependency it adds. The
        // default dpkg -i runs a second elevated apt-get when it fails, so a
        // cancelled password prompt would open another.
        process.env[PACKAGE_MANAGER_ENV] = "apt";
        try {
          updater.quitAndInstall();
        } finally {
          delete process.env[PACKAGE_MANAGER_ENV];
        }
      });
    },
  };
}
