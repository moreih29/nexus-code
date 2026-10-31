/**
 * App-update domain — IPC registration, GitHub Releases polling, and
 * state-persisted channel/ignoredVersion management.
 *
 * LIFECYCLE
 * ---------
 *   installUpdatesDomain({ broadcast, stateService, currentVersion })
 *     → registers `updates.check` and `updates.setIgnoredVersion` IPC handlers,
 *       and `updates.install` / `updates.restart` for an in-place update
 *       (installer.ts) when the app can replace itself
 *     → fires one silent auto-poll after app.whenReady() via the returned
 *       `runInitialAutoPoll()` callback (called by the bootstrap in index.ts)
 *     → subscribes to updateChannel changes so a channel switch resets
 *       ignoredUpdateVersion and triggers another silent auto-poll
 *
 * BROADCAST RULES
 * ---------------
 *   auto  trigger: only broadcast on "newer"; suppress "current" and "error"
 *   manual trigger: always broadcast ("checking" with 3-second delay, then result)
 *
 * DEDUPE
 * ------
 *   The last broadcasted (kind, latest) pair is remembered.  An identical
 *   pair is skipped to avoid duplicate toasts.
 *
 * IGNORED VERSION
 * ---------------
 *   When an auto-poll returns "newer" and `latest` matches
 *   `ignoredUpdateVersion`, the broadcast is suppressed. A manual check still
 *   reports it: the user asked, and the About panel waits for the answer.
 *
 * CURRENT STATUS
 * --------------
 *   Every check result and update step is remembered, broadcast or not, with
 *   the download's progress, so a view opened later (Settings › About) reads
 *   where the update stands with `updates.getStatus`.
 */

import { shell } from "electron";
import { createLogger } from "../../../shared/log/main";
import { ipcOk } from "../../../shared/ipc/result";
import { register, validateArgs } from "../../infra/ipc-router";
import { ipcContract } from "../../../shared/ipc/contract";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import type { StateService } from "../../infra/storage/state-service";
import type { TimerScheduler } from "../../../shared/util/timer-scheduler";
import { defaultTimerScheduler } from "../../../shared/util/timer-scheduler";
import {
  nextUpdateStatus,
  type UpdateProgress,
  type UpdateStatus,
} from "../../../shared/updates/status";
import { createUpdateInstaller, type UpdateBackend } from "./installer";
import {
  createConditionalCache,
  pollGithubReleases,
  type PollResult,
  REPO_BASE,
} from "./poller";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Trigger = "auto" | "manual";

type StatusPayload = Extract<UpdateStatus, { trigger: Trigger }>;

export interface InstallUpdatesDomainOptions {
  broadcast: (channel: string, event: string, payload: unknown) => void;
  stateService: StateService;
  /** Value of `app.getVersion()` — injected for testability. */
  currentVersion: string;
  /** Optional timer injection for deterministic tests (default: real timers). */
  timerScheduler?: TimerScheduler;
  /**
   * Optional fetch implementation forwarded to the poller.
   * Omit in production; inject a mock in tests.
   */
  fetchImpl?: typeof fetch;
  /**
   * Installs updates in place. Omitted where the app cannot replace itself (an
   * unpackaged or non-macOS build): "newer" then offers the release page only.
   */
  updateBackend?: UpdateBackend;
}

export interface UpdatesDomainHandle {
  /**
   * Fire the initial silent auto-poll.  Must be called once inside
   * `app.whenReady().then(...)` after `installUpdatesDomain` returns.
   */
  runInitialAutoPoll(): void;
  /**
   * Trigger a manual update check from main-process code (e.g. menu click).
   * Equivalent to the `updates.check` IPC call with `trigger:"manual"`,
   * but bypasses IPC entirely so no renderer round-trip is needed.
   */
  checkManual(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const logger = createLogger("updates");

const c = ipcContract.updates.call;

/**
 * Installs the updates domain: registers IPC handlers and returns a handle
 * whose `runInitialAutoPoll()` should be called inside `app.whenReady()`.
 */
export function installUpdatesDomain(options: InstallUpdatesDomainOptions): UpdatesDomainHandle {
  const {
    broadcast,
    stateService,
    currentVersion,
    timerScheduler = defaultTimerScheduler,
    fetchImpl,
    updateBackend,
  } = options;

  // What `updates.getStatus` answers.
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
      // In-place update progress is never deduped: each step is news.
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

  // ------------------------------------------------------------------
  // Dedupe state: remember the last broadcasted (kind, latest) pair.
  // ------------------------------------------------------------------
  let lastBroadcastKey: string | null = null;

  // ------------------------------------------------------------------
  // Shared ETag cache for conditional release-metadata requests.
  //
  // The poller reads release artifacts off github.com / its CDN (not the
  // rate-limited api.github.com REST API), so the hard 60 req/h-per-IP cap no
  // longer applies. The ETag cache is still worthwhile: a 304 Not Modified
  // skips re-downloading + re-parsing the metadata on every "Check for
  // Updates" click within a process session. Reused across polls so repeated
  // checks stay cheap until the latest release actually changes.
  // ------------------------------------------------------------------
  const conditionalCache = createConditionalCache();

  function broadcastStatus(payload: StatusPayload): void {
    // Build a dedupe key from kind + latest (if present).
    const dedupeKey = buildDedupeKey(payload);

    // Dedupe is intended to suppress noisy *auto-poll* repeats (the same
    // "newer" notice every ~30 minutes, or repeated "error" while offline).
    // Manual triggers are the user's explicit ask for an answer — silently
    // dropping the response leaves them clicking a no-op button. So we
    // bypass dedupe whenever trigger=manual and still record the key so
    // the *next* auto-poll dedupes against this latest broadcast.
    if (
      payload.trigger !== "manual" &&
      dedupeKey !== null &&
      dedupeKey === lastBroadcastKey
    ) {
      logger.info(`updates: skip dup broadcast key=${dedupeKey}`);
      return;
    }

    if (dedupeKey !== null) {
      lastBroadcastKey = dedupeKey;
    }

    broadcast("updates", "statusChanged", payload);
  }

  // ------------------------------------------------------------------
  // Core poll logic
  // ------------------------------------------------------------------

  async function doPoll(trigger: Trigger): Promise<void> {
    const state = stateService.getState();
    const channel = state.updateChannel ?? "stable";
    const ignoredVersion = state.ignoredUpdateVersion ?? null;

    const result: PollResult = await pollGithubReleases({
      channel,
      currentVersion,
      fetchImpl,
      cache: conditionalCache,
    });

    if (result.kind === "error") {
      logger.warn(`updates: check failed (trigger=${trigger}): ${result.message}`);
    }

    const payload = buildPayload(result, trigger, installer !== undefined);
    remember(payload);

    const shouldBroadcast = shouldBroadcastResult(result, trigger, ignoredVersion);
    if (!shouldBroadcast) {
      logger.debug(`updates: suppressing ${result.kind} for trigger=${trigger}`);
      return;
    }

    broadcastStatus(payload);
  }

  // ------------------------------------------------------------------
  // Poll with optional 3-second progress broadcast for manual trigger
  // ------------------------------------------------------------------

  function poll(trigger: Trigger): void {
    let progressHandle: unknown | null = null;

    if (trigger === "manual") {
      // After 3 seconds, if the poll has not yet resolved, broadcast "checking".
      let settled = false;

      progressHandle = timerScheduler.setTimeout(() => {
        if (!settled) {
          remember({ kind: "checking", trigger: "manual" });
          broadcastStatus({ kind: "checking", trigger: "manual" });
        }
      }, 3000);

      void doPoll(trigger).then(() => {
        settled = true;
        if (progressHandle !== null) {
          timerScheduler.clearTimeout(progressHandle);
          progressHandle = null;
        }
      }).catch((err: unknown) => {
        settled = true;
        if (progressHandle !== null) {
          timerScheduler.clearTimeout(progressHandle);
          progressHandle = null;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`updates: unexpected error in poll: ${message}`);
        remember({ kind: "error", trigger, reason: "unexpected" });
        broadcastStatus({ kind: "error", trigger, reason: "unexpected" });
      });
    } else {
      // Auto: fire and forget — errors are silent (not broadcast).
      void doPoll(trigger).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`updates: unexpected error in auto poll: ${message}`);
      });
    }
  }

  // ------------------------------------------------------------------
  // Guard: auto-poll fires at most once globally per process lifetime.
  // Multiple workspace opens or repeated calls must not re-trigger it.
  // ------------------------------------------------------------------
  let autoPollFired = false;

  function fireAutoPoll(): void {
    if (autoPollFired) return;
    // Respect the user's preference: when autoCheckForUpdates is false the
    // auto-poll is skipped silently. We do NOT mark `autoPollFired = true`
    // here — if the user re-enables the setting later (channel change path
    // or future direct toggle wiring), the poll should fire then. Manual
    // checks (App menu / About panel button) bypass this gate entirely.
    const enabled = stateService.getState().autoCheckForUpdates ?? true;
    if (!enabled) {
      logger.info("updates: auto-poll suppressed (autoCheckForUpdates=false)");
      return;
    }
    autoPollFired = true;
    poll("auto");
  }

  // ------------------------------------------------------------------
  // Subscribe to updateChannel changes.
  // When the channel changes: reset ignoredUpdateVersion + re-fire auto poll.
  // ------------------------------------------------------------------
  let lastKnownChannel = stateService.getState().updateChannel ?? "stable";

  // We hook into the stateService by wrapping it once at install time.
  // The check is performed in the IPC handler for appState.set — but since
  // we cannot hook stateService directly here without modifying it, we instead
  // subscribe via a lightweight periodic check on the `check` call path AND
  // expose a function that index.ts can call from the appState domain.
  //
  // Simpler approach: poll channel at the start of every `doPoll` call, and
  // expose a `notifyChannelMayHaveChanged` so index.ts can call it when
  // `appState.set` includes `updateChannel`.
  //
  // Per the spec: channel change detection happens via a subscription.
  // We implement it by patching mergeState/setState to call our hook.
  // That avoids modifying StateService itself.
  const originalSetState = stateService.setState.bind(stateService);
  stateService.setState = function patchedSetState(partial) {
    originalSetState(partial);
    if ("updateChannel" in partial) {
      const newChannel = stateService.getState().updateChannel ?? "stable";
      if (newChannel !== lastKnownChannel) {
        lastKnownChannel = newChannel;
        logger.info(`updates: channel changed to ${newChannel}, resetting ignoredVersion`);
        // Reset ignoredUpdateVersion and re-fire auto poll.
        originalSetState({ ignoredUpdateVersion: null });
        // Reset dedupe state so the next result is always broadcast.
        lastBroadcastKey = null;
        // Allow the auto poll to fire again after a channel change.
        autoPollFired = false;
        fireAutoPoll();
      }
    }
  };

  // ------------------------------------------------------------------
  // IPC handlers
  // ------------------------------------------------------------------

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

      restart: () => {
        installer?.restart();
        return ipcOk(undefined);
      },

      openReleasePage: (args: unknown) => {
        const { url } = validateArgs(c.openReleasePage.args, args);
        if (isExternalSchemeAllowed(url)) {
          void shell.openExternal(url);
        } else {
          logger.warn(`updates: blocked openReleasePage with disallowed scheme: ${url}`);
        }
        return ipcOk(undefined);
      },

      getStatus: () => ipcOk({ status: currentStatus, progress: currentProgress }),
    },

    listen: {
      statusChanged: {},
      progress: {},
    },
  });

  return {
    runInitialAutoPoll(): void {
      fireAutoPoll();
    },
    checkManual(): void {
      poll("manual");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the poll result should be broadcast given the trigger and
 * the current ignoredUpdateVersion.
 */
function shouldBroadcastResult(
  result: PollResult,
  trigger: Trigger,
  ignoredVersion: string | null,
): boolean {
  // Auto trigger: only broadcast "newer"; suppress "current" and "error".
  if (trigger === "auto" && result.kind !== "newer") {
    return false;
  }

  // Ignored version: suppress an auto "newer" when latest matches ignored.
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

/**
 * Map a PollResult + trigger into the broadcast payload shape.
 */
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

/**
 * Build a string key for dedupe comparison.
 * Returns null for "checking" (we never dedupe those).
 */
function buildDedupeKey(payload: StatusPayload): string | null {
  if (payload.kind === "checking") return null;
  if (payload.kind === "newer") return `newer:${payload.latest}`;
  if (payload.kind === "current") return `current:${payload.latest ?? ""}`;
  // error — dedupe on the failure to avoid spamming identical error toasts.
  return `error:${payload.reason}:${payload.status ?? ""}`;
}
