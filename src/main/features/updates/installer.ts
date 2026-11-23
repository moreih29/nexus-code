import type { Logger } from "../../../shared/log/types";

export type UpdateChannel = "stable" | "beta";

export interface DownloadProgress {
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

export interface UpdateBackend {
  readonly installAsksForPassword: boolean;
  check(channel: UpdateChannel): Promise<string | null>;
  download(): Promise<void>;
  onProgress(listener: (progress: DownloadProgress) => void): void;
  onStaged(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  prepareRestart?(): Promise<void>;
  quitAndInstall(): void | Promise<void>;
}

export type InstallStatus =
  | { kind: "downloading"; version: string }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string; asksForPassword?: true }
  | { kind: "installFailed"; releaseUrl: string };

export interface UpdateInstaller {
  install(channel: UpdateChannel): Promise<void>;
  restart(): Promise<void>;
}

export interface CreateUpdateInstallerOptions {
  backend: UpdateBackend;
  onStatus: (status: InstallStatus) => void;
  onProgress: (version: string, progress: DownloadProgress) => void;
  releaseUrl: (version: string | null) => string;
  logger: Pick<Logger, "info" | "warn">;
}

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "downloading"; version: string }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string };

export function createUpdateInstaller(options: CreateUpdateInstallerOptions): UpdateInstaller {
  const { backend, onStatus, onProgress, releaseUrl, logger } = options;
  let state: State = { kind: "idle" };
  let preparingRestart = false;

  function fail(version: string | null, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `updates: in-place update to ${version ?? "the latest version"} failed: ${message}`,
    );
    state = { kind: "idle" };
    onStatus({ kind: "installFailed", releaseUrl: releaseUrl(version) });
  }

  function ready(version: string): InstallStatus {
    return backend.installAsksForPassword
      ? { kind: "ready", version, asksForPassword: true }
      : { kind: "ready", version };
  }

  backend.onStaged(() => {
    if (state.kind !== "downloading" && state.kind !== "verifying") return;
    logger.info(`updates: ${state.version} is staged; it installs on restart`);
    state = { kind: "ready", version: state.version };
    onStatus(ready(state.version));
  });
  backend.onError((error) => {
    if (state.kind === "downloading" || state.kind === "verifying" || state.kind === "ready") {
      fail(state.version, error);
    }
  });
  backend.onProgress((progress) => {
    if (state.kind === "downloading") onProgress(state.version, progress);
  });

  return {
    async install(channel) {
      if (state.kind === "downloading" || state.kind === "verifying") {
        onStatus({ kind: state.kind, version: state.version });
        return;
      }
      if (state.kind === "ready") {
        onStatus(ready(state.version));
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
        if (state.kind === "downloading") {
          state = { kind: "verifying", version };
          onStatus({ kind: "verifying", version });
        }
      } catch (error) {
        if (state.kind === "starting" || state.kind === "downloading") fail(version, error);
      }
    },

    async restart() {
      if (state.kind !== "ready" || preparingRestart) return;
      const readyUpdate = state;
      preparingRestart = true;
      try {
        if (backend.prepareRestart) await backend.prepareRestart();
        if (state === readyUpdate) await backend.quitAndInstall();
      } catch (error) {
        if (state === readyUpdate) fail(readyUpdate.version, error);
      } finally {
        preparingRestart = false;
      }
    },
  };
}
