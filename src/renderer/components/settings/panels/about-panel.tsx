import { ExternalLink } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type SitePage, siteUrl } from "../../../../shared/site";
import type { UpdateProgress, UpdateStatus } from "../../../../shared/updates/status";
import { formatBytes } from "../../../../shared/util/format-bytes";
import { ipcCallResult } from "../../../ipc/client";
import { checkForUpdates, installUpdate } from "../../../services/updates/operations";
import { updateCheckFailedMessage } from "../../../services/updates/update-check-failure";
import { showReleaseNotes } from "../../../state/operations/release-notes";
import { useUpdatesStore } from "../../../state/stores/updates";
import { Button } from "../../ui/button";
import { CopyButton } from "../../ui/copy-button";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import { BugReportGroup } from "./bug-report-group";

const APP_NAME = "NexusCode";
const COPYRIGHT = "Copyright © 2026 moreih29";

export function AboutPanel() {
  const { t } = useTranslation("settings");
  const autoCheckEnabled = useUpdatesStore((s) => s.autoCheckEnabled);
  const setAutoCheckEnabled = useUpdatesStore((s) => s.setAutoCheckEnabled);
  const status = useUpdatesStore((s) => s.status);
  const progress = useUpdatesStore((s) => s.progress);
  const checking = useUpdatesStore((s) => s.checking);
  const storeManaged = window.host?.windowsStore === true;

  const handleAutoCheckChange = useCallback(
    (next: boolean) => {
      setAutoCheckEnabled(next);
      void ipcCallResult("appState", "set", { autoCheckForUpdates: next });
    },
    [setAutoCheckEnabled],
  );

  return (
    <SettingsPage>
      <SettingsGroup>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-app-body-emphasis text-foreground">{APP_NAME}</div>
            <div className="text-app-ui-sm text-muted-foreground">{COPYRIGHT}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => showReleaseNotes(status?.kind === "newer" ? status.latest : null)}
            data-testid="about-release-notes"
          >
            {t("about.releaseNotes")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("about.updates.title")}>
        <VersionRow
          status={status}
          progress={progress}
          checking={checking}
          storeManaged={storeManaged}
        />
        {!storeManaged && (
          <SettingsSwitch
            label={t("about.autoCheck.label")}
            description={t("about.autoCheck.description")}
            checked={autoCheckEnabled}
            onChange={handleAutoCheckChange}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("about.links.title")}>
        <SiteLinks />
      </SettingsGroup>

      <SettingsGroup title={t("about.logs.title")} description={t("about.logs.description")}>
        <LogActions />
      </SettingsGroup>

      <BugReportGroup />
    </SettingsPage>
  );
}

export function VersionRow({
  status,
  progress,
  checking = false,
  storeManaged,
}: {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
  checking?: boolean;
  storeManaged: boolean;
}) {
  const { t } = useTranslation("settings");
  const line = useUpdateStatusText(status);
  const version = t("about.version", { version: __APP_VERSION__ });
  if (storeManaged) {
    return (
      <SettingsRow label={version} description={t("about.storeManaged")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void ipcCallResult("updates", "openStorePage", undefined)}
        >
          {t("about.openStore")}
        </Button>
      </SettingsRow>
    );
  }
  return (
    <>
      <SettingsRow
        label={version}
        description={
          line && (
            <span className={cn("break-keep", line.failed && "text-destructive")}>{line.text}</span>
          )
        }
      >
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <UpdateActions status={status} checking={checking} releaseNotes={false} />
        </div>
      </SettingsRow>
      {(status?.kind === "downloading" || status?.kind === "verifying") && (
        <DownloadProgressBar status={status} progress={progress} />
      )}
    </>
  );
}

const SITE_LINKS = [
  { page: "home", label: "about.links.website" },
  { page: "support", label: "about.links.support" },
  { page: "privacy", label: "about.links.privacy" },
] as const satisfies readonly { page: SitePage; label: string }[];

function SiteLinks() {
  const { t, i18n } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {SITE_LINKS.map(({ page, label }) => (
        <Button key={page} variant="outline" size="sm" asChild>
          <a
            href={siteUrl(page, i18n.language)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`about-site-${page}`}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t(label)}
          </a>
        </Button>
      ))}
    </div>
  );
}

function LogActions() {
  const { t } = useTranslation("settings");
  const logsPath = async (): Promise<string | null> => {
    const result = await ipcCallResult("system", "logsPath", undefined);
    return result.ok ? result.value.path : null;
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void ipcCallResult("system", "openLogsFolder", undefined)}
        data-testid="about-open-logs"
      >
        {t("about.logs.open")}
      </Button>
      <CopyButton
        variant="text"
        viaIpc
        ms={2000}
        text={logsPath}
        label={t("about.logs.copyPath")}
        copiedLabel={t("about.logs.copied")}
        data-testid="about-copy-logs-path"
      />
    </div>
  );
}

function openReleasePage(url: string): void {
  void ipcCallResult("updates", "openReleasePage", { url });
}

export function UpdateSection({
  status,
  progress,
  checking = false,
  releaseNotes = true,
  children,
}: {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
  checking?: boolean;
  releaseNotes?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <UpdateProgressLines status={status} progress={progress} />
      <div className="flex flex-wrap gap-2">
        <UpdateActions status={status} checking={checking} releaseNotes={releaseNotes} />
        {children}
      </div>
    </div>
  );
}

function UpdateProgressLines({
  status,
  progress,
}: {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
}) {
  return (
    <>
      <UpdateStatusLine status={status} />
      {(status?.kind === "downloading" || status?.kind === "verifying") && (
        <DownloadProgressBar status={status} progress={progress} />
      )}
    </>
  );
}

function UpdateActions({
  status,
  checking: checkRunning,
  releaseNotes,
}: {
  status: UpdateStatus | null;
  checking: boolean;
  releaseNotes: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const checking = checkRunning || status?.kind === "checking";
  const downloading = status?.kind === "downloading" || status?.kind === "verifying";
  return (
    <>
      {status?.kind === "newer" && status.canInstall && (
        <Button size="sm" onClick={() => installUpdate(status.latest)}>
          {t("common:updates.install")}
        </Button>
      )}
      {status?.kind === "newer" && !status.canInstall && (
        <Button size="sm" onClick={() => openReleasePage(status.releaseUrl)}>
          {t("common:updates.download")}
        </Button>
      )}
      {status?.kind === "newer" && releaseNotes && (
        <Button variant="outline" size="sm" onClick={() => showReleaseNotes(status.latest)}>
          {t("about.releaseNotes")}
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
      <Button
        variant="outline"
        size="sm"
        onClick={checkForUpdates}
        disabled={checking || downloading}
        data-testid="update-check"
      >
        {checking ? t("about.checking") : t("about.checkNow")}
      </Button>
    </>
  );
}

function useUpdateStatusText(
  status: UpdateStatus | null,
): { text: string; failed: boolean } | null {
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
  return { text, failed: status?.kind === "error" || status?.kind === "installFailed" };
}

function UpdateStatusLine({ status }: { status: UpdateStatus | null }) {
  const line = useUpdateStatusText(status);
  if (line === null) return null;
  return (
    <p
      className={line.failed ? "text-app-ui-sm text-destructive" : "text-app-ui-sm text-foreground"}
    >
      {line.text}
    </p>
  );
}

function DownloadProgressBar({
  status,
  progress,
}: {
  status: Extract<UpdateStatus, { kind: "downloading" | "verifying" }>;
  progress: UpdateProgress | null;
}) {
  const { t } = useTranslation("settings");
  const known = status.kind === "downloading" && progress !== null && progress.total > 0;
  const percent = known
    ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
    : 0;
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
