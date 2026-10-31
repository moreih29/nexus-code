// src/renderer/components/settings/panels/about-panel.tsx
//
// About / Info panel — replaces the previous Updates panel.
//
// Shows the product name, the app version (injected at build time via the
// `__APP_VERSION__` Vite define — see `electron.vite.config.ts`), the
// copyright line, an auto-check toggle, and a manual "Check for Updates"
// action.
//
// The Update Channel SegmentedControl (stable / beta) is intentionally not
// rendered at this stage: no GA release exists yet, so a channel toggle has
// no effect for end users. The backend updates domain (poller, AppState
// `updateChannel`, NEXUS_CHANNEL build constant, SSH agent root split) is
// preserved untouched so that surfacing the toggle later only needs a
// re-introduced control here.
//
// Auto-check toggle policy:
//   - On  (default): app start fires one silent GH Releases poll. A toast
//                    appears only when a newer version is found.
//   - Off          : the startup poll is skipped. The "Check for Updates"
//                    button below always works regardless of this setting —
//                    it is the user's explicit ask and is never gated.
//
// Below the button the panel shows where an update stands, from the updates
// store: the last check's answer, then the download with its progress, the
// signature check (macOS), and the restart that installs it.
//
// A Microsoft Store install shows none of this: the Store updates it, and a
// GitHub release has no build for it.
//
// Toasts are driven by the global `initUpdatesSubscriptions()` listener
// (bootstrap-level), which also feeds the store this panel reads.

import { useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateProgress, UpdateStatus } from "../../../../shared/updates/status";
import { ipcCallResult } from "../../../ipc/client";
import { updateCheckFailedMessage } from "../../../state/operations/update-check-failure";
import { useUpdatesStore } from "../../../state/stores/updates";
import { formatBytes } from "../../../utils/format-bytes";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";

// ---------------------------------------------------------------------------
// Static product metadata
// ---------------------------------------------------------------------------

const APP_NAME = "NexusCode";
const COPYRIGHT = "Copyright © 2026 moreih29";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AboutPanel() {
  const { t } = useTranslation("settings");
  const autoCheckEnabled = useUpdatesStore((s) => s.autoCheckEnabled);
  const setAutoCheckEnabled = useUpdatesStore((s) => s.setAutoCheckEnabled);
  const status = useUpdatesStore((s) => s.status);
  const progress = useUpdatesStore((s) => s.progress);
  const storeManaged = window.host?.windowsStore === true;

  const autoCheckId = useId();

  const handleAutoCheckChange = useCallback(
    (next: boolean) => {
      // Optimistic local update so the switch flips immediately.
      setAutoCheckEnabled(next);
      // Persist to AppState — fire-and-forget. Failure to persist keeps the
      // visible state and main will re-hydrate on next boot. The poll guard
      // reads `stateService.getState().autoCheckForUpdates` at fire time, so
      // the next app start respects the persisted value.
      void ipcCallResult("appState", "set", { autoCheckForUpdates: next });
    },
    [setAutoCheckEnabled],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Product identity — left-aligned stack to match every other
          Settings panel (Appearance / Editor / Terminal / Notifications). */}
      <div className="flex flex-col gap-1">
        <div className="text-app-body-emphasis text-foreground">{APP_NAME}</div>
        <div className="text-app-ui-sm text-muted-foreground">
          {t("about.version", { version: __APP_VERSION__ })}
        </div>
        <div className="text-app-ui-sm text-muted-foreground">{COPYRIGHT}</div>
      </div>

      {storeManaged ? (
        <p className="text-app-ui-sm text-muted-foreground">{t("about.storeManaged")}</p>
      ) : (
        <>
          {/* Auto-check row — stacked label + helper on the left, Switch
              pinned right. Same pattern as the Notifications panel. */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1 min-w-0">
              <label
                htmlFor={autoCheckId}
                className="text-app-body text-foreground cursor-pointer"
              >
                {t("about.autoCheck.label")}
              </label>
              <p className="text-app-ui-sm text-muted-foreground">
                {t("about.autoCheck.description")}
              </p>
            </div>
            <Switch
              id={autoCheckId}
              checked={autoCheckEnabled}
              onCheckedChange={handleAutoCheckChange}
              className="shrink-0 mt-1"
            />
          </div>

          <UpdateSection status={status} progress={progress} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the update stands
// ---------------------------------------------------------------------------

function checkNow(): void {
  useUpdatesStore.getState().applyStatus({ kind: "checking", trigger: "manual" });
  void ipcCallResult("updates", "check", { trigger: "manual" });
}

function openReleasePage(url: string): void {
  void ipcCallResult("updates", "openReleasePage", { url });
}

/** The current status as a line of text and the actions it offers. */
export function UpdateSection({
  status,
  progress,
}: {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const checkButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={checkNow}
      disabled={status?.kind === "checking"}
    >
      {status?.kind === "checking" ? t("about.checking") : t("about.checkNow")}
    </Button>
  );

  return (
    <div className="flex flex-col items-start gap-3">
      <UpdateStatusLine status={status} />
      {(status?.kind === "downloading" || status?.kind === "verifying") && (
        <DownloadProgressBar status={status} progress={progress} />
      )}
      <div className="flex flex-wrap gap-2">
        {status?.kind === "newer" && status.canInstall && (
          <>
            <Button
              size="sm"
              onClick={() => void ipcCallResult("updates", "install", undefined)}
            >
              {t("common:updates.install")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openReleasePage(status.releaseUrl)}>
              {t("about.releaseNotes")}
            </Button>
          </>
        )}
        {status?.kind === "newer" && !status.canInstall && (
          <Button size="sm" onClick={() => openReleasePage(status.releaseUrl)}>
            {t("common:updates.download")}
          </Button>
        )}
        {status?.kind === "ready" && (
          <Button size="sm" onClick={() => void ipcCallResult("updates", "restart", undefined)}>
            {t("common:updates.restart")}
          </Button>
        )}
        {status?.kind === "installFailed" && (
          <Button variant="outline" size="sm" onClick={() => openReleasePage(status.releaseUrl)}>
            {t("common:updates.openReleasePage")}
          </Button>
        )}
        {(status === null ||
          status.kind === "checking" ||
          status.kind === "current" ||
          status.kind === "error" ||
          status.kind === "installFailed") &&
          checkButton}
      </div>
    </div>
  );
}

function UpdateStatusLine({ status }: { status: UpdateStatus | null }) {
  const { t } = useTranslation("common");
  let text: string | null;
  switch (status?.kind) {
    case undefined:
    case "checking":
      text = null;
      break;
    case "current":
      text = t("updates.upToDate");
      break;
    case "error":
      text = updateCheckFailedMessage(status);
      break;
    case "newer":
      text = t("updates.available", { version: status.latest });
      break;
    case "downloading":
      text = t("updates.downloading", { version: status.version });
      break;
    case "verifying":
      text = t("updates.verifying", { version: status.version });
      break;
    case "ready":
      text = t(status.asksForPassword ? "updates.readyAsksPassword" : "updates.ready", {
        version: status.version,
      });
      break;
    case "installFailed":
      text = t("updates.installFailed");
      break;
  }
  if (text === null) return null;
  return (
    <p
      className={
        status?.kind === "error" || status?.kind === "installFailed"
          ? "text-app-ui-sm text-destructive"
          : "text-app-ui-sm text-foreground"
      }
    >
      {text}
    </p>
  );
}

/**
 * The download's bar: how much of it is in, at what speed. Indeterminate
 * before the first progress report and while the update is verified.
 */
function DownloadProgressBar({
  status,
  progress,
}: {
  status: Extract<UpdateStatus, { kind: "downloading" | "verifying" }>;
  progress: UpdateProgress | null;
}) {
  const { t } = useTranslation("settings");
  const known = status.kind === "downloading" && progress !== null && progress.total > 0;
  const percent = known ? Math.min(100, Math.round((progress.transferred / progress.total) * 100)) : 0;
  return (
    <div className="flex w-full max-w-sm flex-col gap-1">
      <div
        role="progressbar"
        aria-label={t("about.downloadProgress")}
        aria-valuenow={known ? percent : undefined}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        {known ? (
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-full rounded-full bg-muted-foreground/50 motion-safe:animate-pulse" />
        )}
      </div>
      {known && (
        <div className="text-app-ui-sm tabular-nums text-muted-foreground">
          {t("about.progress", {
            percent,
            transferred: formatBytes(progress.transferred),
            total: formatBytes(progress.total),
            speed: formatBytes(progress.bytesPerSecond),
          })}
        </div>
      )}
    </div>
  );
}
