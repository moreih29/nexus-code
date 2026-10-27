/**
 * In-place app update — downloads the newest release on the user's channel and
 * installs it over the running app on restart.
 *
 * Squirrel.Mac (behind electron-updater) takes an update only when its code
 * signature meets the running app's designated requirement. Release builds are
 * all signed with one certificate (scripts/sign-mac.cjs), so each meets the
 * requirement of the one before it; a build signed any other way (a local,
 * ad-hoc one) fails the check, and the user is pointed at the release page
 * instead. The app downloads the update itself, so the new bundle carries no
 * quarantine attribute and opens without a Gatekeeper prompt.
 *
 * STATES
 * ------
 *   idle → starting → downloading(version) → ready(version)
 *   Any failure returns to idle and reports installFailed. restart() installs
 *   a ready update; one the user does not restart for goes in at the next quit.
 */

import type { Logger } from "../../../shared/log/types";

export type UpdateChannel = "stable" | "beta";

/** What the installer needs of electron-updater; tests stand in a fake. */
export interface UpdateBackend {
  /** Resolves the newer version `channel` offers, or null when there is none. */
  check(channel: UpdateChannel): Promise<string | null>;
  /** Downloads the version check() found and hands it to Squirrel.Mac. */
  download(): Promise<void>;
  /** `listener` runs once Squirrel.Mac has verified and staged the update. */
  onStaged(listener: () => void): void;
  /**
   * `listener` runs on any updater failure, including those after download()
   * resolved — Squirrel.Mac checks the signature once the file is handed over.
   */
  onError(listener: (error: Error) => void): void;
  quitAndInstall(): void;
}

export type InstallStatus =
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "installFailed"; releaseUrl: string };

export interface UpdateInstaller {
  /** Starts an update; while one is under way, reports where it stands instead. */
  install(channel: UpdateChannel): Promise<void>;
  /** Quits and installs the staged update; does nothing until one is ready. */
  restart(): void;
}

export interface CreateUpdateInstallerOptions {
  backend: UpdateBackend;
  onStatus: (status: InstallStatus) => void;
  /** Release page of `version`, or of every release when it is not known. */
  releaseUrl: (version: string | null) => string;
  logger: Pick<Logger, "info" | "warn">;
}

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string };

export function createUpdateInstaller(options: CreateUpdateInstallerOptions): UpdateInstaller {
  const { backend, onStatus, releaseUrl, logger } = options;
  let state: State = { kind: "idle" };

  function fail(version: string | null, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `updates: in-place update to ${version ?? "the latest version"} failed: ${message}`,
    );
    state = { kind: "idle" };
    onStatus({ kind: "installFailed", releaseUrl: releaseUrl(version) });
  }

  backend.onStaged(() => {
    if (state.kind !== "downloading") return;
    logger.info(`updates: ${state.version} is staged; it installs on restart`);
    state = { kind: "ready", version: state.version };
    onStatus({ kind: "ready", version: state.version });
  });
  backend.onError((error) => {
    if (state.kind === "downloading") fail(state.version, error);
  });

  return {
    async install(channel) {
      if (state.kind === "downloading" || state.kind === "ready") {
        onStatus({ kind: state.kind, version: state.version });
        return;
      }
      if (state.kind === "starting") return;

      state = { kind: "starting" };
      let version: string | null = null;
      try {
        version = await backend.check(channel);
        if (version === null) throw new Error("the update feed offers no newer version");
        state = { kind: "downloading", version };
        onStatus({ kind: "downloading", version });
        await backend.download();
      } catch (error) {
        // The updater also emits a failed download as an error, which
        // onError has reported already.
        if (state.kind === "starting" || state.kind === "downloading") fail(version, error);
      }
    },

    restart() {
      if (state.kind === "ready") backend.quitAndInstall();
    },
  };
}
