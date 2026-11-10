/**
 * Updates IPC subscriptions — main → renderer wiring.
 *
 * Subscribes to `updates.statusChanged` and fires the appropriate Toast
 * variant based on the discriminated-union payload and trigger type. Every
 * status, and each `updates.progress`, also goes to the updates store, which
 * the About panel and the title bar's update button show.
 *
 * TOAST RULES
 * -----------
 *   kind=checking   (manual only)  → plain info toast, short duration
 *   kind=newer                     → action toast: "Update" (or "Download", which
 *                                    opens the release page, when the app cannot
 *                                    update in place) + "Skip this version".
 *                                    A check the user asked for always shows it;
 *                                    one the app made by itself (every few
 *                                    hours) shows a version once, and never one
 *                                    skipped. The title bar's update button
 *                                    shows it from then on.
 *   kind=current  + trigger=manual → plain info toast 3 s
 *   kind=current  + trigger=auto   → silent
 *   kind=error    + trigger=manual → error toast
 *   kind=error    + trigger=auto   → silent
 *   kind=downloading / verifying /
 *        ready                     → silent: the title bar's update button
 *                                    shows the download and the restart
 *   kind=installFailed             → error toast with "Open Release Page"
 *
 * INITIALIZATION
 * --------------
 *   Call `initUpdatesSubscriptions()` once during app bootstrap (after the
 *   IPC bridge is installed).  The function is idempotent — a second call
 *   unsubscribes the previous listener and installs a fresh one (safe for HMR).
 *   It then reads the status the broadcasts so far left, for the store, and
 *   tells of a newer version found before the window listened.
 */

import i18next from "i18next";
import type { UpdateStatus } from "../../../shared/updates/status";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useUpdatesStore } from "../stores/updates";
import { updateCheckFailedMessage } from "./update-check-failure";

type NewerStatus = Extract<UpdateStatus, { kind: "newer" }>;

/**
 * Starts the in-place update to `version`. Main looks the version up again
 * before it says the download began, which can take a moment, so the
 * button turns to the download at once; a call that fails puts back what
 * it showed. Main's own statuses take over from there, its failure too.
 */
export function installUpdate(version: string): void {
  const store = useUpdatesStore.getState();
  const before = store.status;
  store.applyStatus({ kind: "downloading", version });
  void ipcCallResult("updates", "install", undefined).then((result) => {
    if (result.ok) return;
    const now = useUpdatesStore.getState();
    if (now.status?.kind === "downloading" && now.status.version === version) {
      now.restoreStatus(before);
    }
  });
}

/** Skips `version`: the title bar stops offering it, and the app's own checks never tell of it. */
export function skipVersion(version: string): void {
  useUpdatesStore.getState().setIgnoredVersion(version);
  void ipcCallResult("updates", "setIgnoredVersion", { version });
}

/**
 * Tells the user of a newer version with a toast: always when they `asked`,
 * otherwise once a version, and never one they skipped.
 */
function announceNewer(status: NewerStatus, asked: boolean): void {
  const store = useUpdatesStore.getState();
  const { latest, releaseUrl, canInstall } = status;
  if (!asked && (latest === store.ignoredVersion || latest === store.announcedVersion)) return;
  if (latest !== store.announcedVersion) {
    store.setAnnouncedVersion(latest);
    void ipcCallResult("appState", "set", { announcedUpdateVersion: latest });
  }
  showToast({
    kind: "info",
    message: i18next.t("common:updates.available", { version: latest }),
    actions: [
      canInstall
        ? {
            label: i18next.t("common:updates.install"),
            onAction: () => installUpdate(latest),
          }
        : {
            label: i18next.t("common:updates.download"),
            onAction: () => {
              void ipcCallResult("updates", "openReleasePage", { url: releaseUrl });
            },
          },
      {
        label: i18next.t("common:updates.skipVersion"),
        onAction: () => skipVersion(latest),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

let activeUnsub: Unsubscribe | null = null;

/**
 * Install (or reinstall) the `updates.statusChanged` → toast subscription.
 *
 * Safe to call multiple times — previous listener is removed first.
 */
export function initUpdatesSubscriptions(): void {
  if (activeUnsub !== null) {
    activeUnsub();
    activeUnsub = null;
  }

  const unsubscribeStatus = ipcListen("updates", "statusChanged", (status) => {
    useUpdatesStore.getState().applyStatus(status);
    switch (status.kind) {
      case "checking":
        // Only broadcast for manual trigger (main suppresses auto-trigger checking).
        showToast({
          kind: "info",
          message: i18next.t("common:updates.checking"),
          durationMs: 3000,
        });
        break;

      case "newer":
        announceNewer(status, status.trigger === "manual");
        break;

      case "current":
        // Only show a toast for manual triggers; auto-triggered "current" is silent.
        if (status.trigger === "manual") {
          showToast({
            kind: "info",
            message: i18next.t("common:updates.upToDate"),
            durationMs: 3000,
          });
        }
        break;

      case "error":
        // Only show a toast for manual triggers; auto-triggered errors are silent.
        if (status.trigger === "manual") {
          showToast({
            kind: "error",
            message: updateCheckFailedMessage(status),
          });
        }
        break;

      case "downloading":
      case "verifying":
      case "ready":
        break;

      case "installFailed": {
        const { releaseUrl } = status;
        showToast({
          kind: "error",
          message: i18next.t("common:updates.installFailed"),
          actions: [
            {
              label: i18next.t("common:updates.openReleasePage"),
              onAction: () => {
                void ipcCallResult("updates", "openReleasePage", { url: releaseUrl });
              },
            },
          ],
        });
        break;
      }
    }
  });
  const unsubscribeProgress = ipcListen("updates", "progress", (progress) => {
    useUpdatesStore.getState().applyProgress(progress);
  });
  activeUnsub = () => {
    unsubscribeStatus();
    unsubscribeProgress();
  };

  void ipcCallResult("updates", "getStatus", undefined).then((result) => {
    if (!result.ok) return;
    const { status, progress } = result.value;
    const store = useUpdatesStore.getState();
    // A broadcast that arrived meanwhile is newer.
    if (status === null || store.status !== null) return;
    store.applyStatus(status);
    if (progress !== null) store.applyProgress(progress);
    if (status.kind === "newer") announceNewer(status, false);
  });
}
