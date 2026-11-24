import { shell } from "electron";
import { gt, valid } from "semver";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import { errorText, limitLog } from "../../../shared/log/limit";
import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import {
  nextUpdateStatus,
  type UpdateProgress,
  type UpdateStatus,
} from "../../../shared/updates/status";
import type { TimerScheduler } from "../../../shared/util/timer-scheduler";
import { defaultTimerScheduler } from "../../../shared/util/timer-scheduler";
import { register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { createAutoCheck } from "./auto-check";
import { createUpdateInstaller, type UpdateBackend } from "./installer";
import { STORE_PAGE_URL } from "./microsoft-store";
import { createConditionalCache, type PollResult, pollGithubReleases, REPO_BASE } from "./poller";
import { createReleaseNotesCache, fetchReleaseNotes } from "./release-notes";

type Trigger = "auto" | "manual";

type StatusPayload = Extract<UpdateStatus, { trigger: Trigger }>;

export interface InstallUpdatesDomainOptions {
  broadcast: (channel: string, event: string, payload: unknown) => void;
  stateService: StateService;
  currentVersion: string;
  timerScheduler?: TimerScheduler;
  now?: () => number;
  fetchImpl?: typeof fetch;
  updateBackend?: UpdateBackend;
}

export interface UpdatesDomainHandle {
  startAutoChecks(): void;
  onResume(): void;
  checkManual(): void;
}

const logger = createLogger("updates");
const repeated = limitLog(logger);

const c = ipcContract.updates.call;

async function openUpdateLink(url: string) {
  try {
    await shell.openExternal(url);
    return ipcOk(undefined);
  } catch {
    logger.warn("Could not open link to updates");
    return ipcErr("open-external-failed", "Could not open link to updates");
  }
}

export function installUpdatesDomain(options: InstallUpdatesDomainOptions): UpdatesDomainHandle {
  const {
    broadcast,
    stateService,
    currentVersion,
    timerScheduler = defaultTimerScheduler,
    now = Date.now,
    fetchImpl,
    updateBackend,
  } = options;

  let currentStatus: UpdateStatus | null = null;
  let currentProgress: UpdateProgress | null = null;

  function remember(status: UpdateStatus): void {
    currentStatus = nextUpdateStatus(currentStatus, status);
    if (currentStatus?.kind !== "downloading") currentProgress = null;
  }

  const installer =
    updateBackend &&
    createUpdateInstaller({
      backend: updateBackend,
      onStatus: (status) => {
        remember(status);
        broadcast("updates", "statusChanged", status);
      },
      onProgress: (version, progress) => {
        currentProgress = { version, ...progress };
        broadcast("updates", "progress", currentProgress);
      },
      releaseUrl: (version) =>
        version === null ? `${REPO_BASE}/releases` : `${REPO_BASE}/releases/tag/v${version}`,
      logger,
    });

  let lastBroadcastKey: string | null = null;

  const conditionalCache = { stable: createConditionalCache(), beta: createConditionalCache() };
  let channelGeneration = 0;
  let manualCheck: symbol | undefined;
  const releaseNotesCache = createReleaseNotesCache();

  function broadcastStatus(payload: StatusPayload): void {
    const dedupeKey = buildDedupeKey(payload);

    if (payload.trigger !== "manual" && dedupeKey !== null && dedupeKey === lastBroadcastKey) {
      logger.info(`updates: skip dup broadcast key=${dedupeKey}`);
      return;
    }

    if (dedupeKey !== null) {
      lastBroadcastKey = dedupeKey;
    }

    broadcast("updates", "statusChanged", payload);
  }

  async function doPoll(trigger: Trigger, generation: number): Promise<void> {
    const state = stateService.getState();
    const channel = state.updateChannel ?? "stable";

    const result: PollResult = await pollGithubReleases({
      channel,
      currentVersion,
      fetchImpl,
      cache: conditionalCache[channel],
    });

    if (generation !== channelGeneration) return;
    if (result.kind === "error") {
      repeated.log(
        "warn",
        `check-failed:${trigger}`,
        `updates: check failed (trigger=${trigger}): ${errorText(result.message, 200, redactLogSecrets)}`,
      );
    }

    const payload = buildPayload(result, trigger, installer !== undefined);
    const staged = currentStatus?.kind === "ready" ? currentStatus.version : null;
    remember(payload);

    const ignoredVersion = stateService.getState().ignoredUpdateVersion ?? null;
    const shouldBroadcast = shouldBroadcastResult(result, trigger, ignoredVersion);
    if (!shouldBroadcast) {
      repeated.log(
        "debug",
        `suppress:${result.kind}:${trigger}`,
        `updates: suppressing ${result.kind} for trigger=${trigger}`,
      );
      return;
    }

    broadcastStatus(payload);

    if (
      trigger === "manual" &&
      installer !== undefined &&
      staged !== null &&
      result.kind === "newer" &&
      isPast(result.latest, staged)
    ) {
      void installer.install(channel);
    }
  }

  function poll(trigger: Trigger): void {
    const generation = channelGeneration;

    if (trigger === "manual") {
      const check = Symbol();
      manualCheck = check;
      const progressHandle = timerScheduler.setTimeout(() => {
        if (generation !== channelGeneration || manualCheck !== check) return;
        remember({ kind: "checking", trigger: "manual" });
        broadcastStatus({ kind: "checking", trigger: "manual" });
      }, 3000);

      void doPoll(trigger, generation)
        .catch((err: unknown) => {
          if (generation !== channelGeneration) return;
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`updates: unexpected error in poll: ${message}`);
          const error = { kind: "error", trigger, reason: "unexpected" } as const;
          remember(error);
          broadcastStatus(error);
        })
        .finally(() => {
          timerScheduler.clearTimeout(progressHandle);
          if (manualCheck === check) manualCheck = undefined;
        });
    } else {
      void doPoll(trigger, generation).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`updates: unexpected error in auto poll: ${message}`);
      });
    }
  }

  const autoCheck = createAutoCheck({
    timer: timerScheduler,
    now,
    check: () => {
      const enabled = stateService.getState().autoCheckForUpdates ?? true;
      if (!enabled) {
        logger.info("updates: auto-poll suppressed (autoCheckForUpdates=false)");
        return;
      }
      poll("auto");
    },
  });

  let lastKnownChannel = stateService.getState().updateChannel ?? "stable";

  const originalSetState = stateService.setState.bind(stateService);
  stateService.setState = function patchedSetState(partial, mergeLayouts) {
    originalSetState(partial, mergeLayouts);
    if ("updateChannel" in partial) {
      const newChannel = stateService.getState().updateChannel ?? "stable";
      if (newChannel !== lastKnownChannel) {
        lastKnownChannel = newChannel;
        channelGeneration++;
        logger.info(`updates: channel changed to ${newChannel}, resetting ignoredVersion`);
        originalSetState({ ignoredUpdateVersion: null });
        lastBroadcastKey = null;
        if (manualCheck) poll("manual");
        else autoCheck.checkNow();
      }
    }
  };

  register("updates", {
    call: {
      check: (args: unknown) => {
        const { trigger } = validateArgs(c.check.args, args);
        poll(trigger);
        return ipcOk(undefined);
      },

      setIgnoredVersion: (args: unknown) => {
        const { version } = validateArgs(c.setIgnoredVersion.args, args);
        stateService.setState({ ignoredUpdateVersion: version });
        logger.info(`updates: ignoredUpdateVersion set to ${version ?? "null"}`);
        return ipcOk(undefined);
      },

      install: () => {
        void installer?.install(stateService.getState().updateChannel ?? "stable");
        return ipcOk(undefined);
      },

      restart: async () => {
        await installer?.restart();
        return ipcOk(undefined);
      },

      openReleasePage: (args: unknown) => {
        const { url } = validateArgs(c.openReleasePage.args, args);
        if (!isExternalSchemeAllowed(url)) {
          logger.warn("Blocked update link with disallowed scheme");
          return ipcErr("invalid-args", "Unsupported update link");
        }
        return openUpdateLink(url);
      },

      getStatus: () => ipcOk({ status: currentStatus, progress: currentProgress }),

      openStorePage: () => {
        return process.windowsStore ? openUpdateLink(STORE_PAGE_URL) : ipcOk(undefined);
      },

      releaseNotes: async () => {
        const result = await fetchReleaseNotes({
          channel: stateService.getState().updateChannel ?? "stable",
          fetchImpl,
          cache: releaseNotesCache,
        });
        if (result.kind === "error") {
          logger.warn(`updates: release notes not read (${result.reason})`);
        }
        return ipcOk(result);
      },
    },

    listen: {
      statusChanged: {},
      progress: {},
    },
  });

  return {
    startAutoChecks(): void {
      autoCheck.start();
    },
    onResume(): void {
      autoCheck.resume();
    },
    checkManual(): void {
      poll("manual");
    },
  };
}

function isPast(version: string, staged: string): boolean {
  return valid(version) !== null && valid(staged) !== null && gt(version, staged);
}

function shouldBroadcastResult(
  result: PollResult,
  trigger: Trigger,
  ignoredVersion: string | null,
): boolean {
  if (trigger === "auto" && result.kind !== "newer") {
    return false;
  }

  if (
    trigger === "auto" &&
    result.kind === "newer" &&
    ignoredVersion !== null &&
    result.latest === ignoredVersion
  ) {
    return false;
  }

  return true;
}

function buildPayload(result: PollResult, trigger: Trigger, canInstall: boolean): StatusPayload {
  switch (result.kind) {
    case "newer":
      return {
        kind: "newer",
        trigger,
        current: result.current,
        latest: result.latest,
        releaseUrl: result.releaseUrl,
        canInstall,
      };
    case "current":
      return {
        kind: "current",
        trigger,
        current: result.current,
        latest: result.latest,
      };
    case "error":
      return { kind: "error", trigger, reason: result.reason, status: result.status };
  }
}

function buildDedupeKey(payload: StatusPayload): string | null {
  if (payload.kind === "checking") return null;
  if (payload.kind === "newer") return `newer:${payload.latest}`;
  if (payload.kind === "current") return `current:${payload.latest ?? ""}`;
  return `error:${payload.reason}:${payload.status ?? ""}`;
}
