// The title bar's update button: shown only while there is an update to
// take — a newer version, its download, the restart that installs it, or
// an install that failed. The app checks every few hours while it runs, and
// tells of a version with a toast only once; this is where it stays.
// Clicking it shows where the update stands with its actions, as Settings ›
// About does.

import { CircleArrowUp, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type UpdateButton as Shown, updateButtonOf } from "../../services/updates/update-button";
import { skipVersion } from "../../state/operations/updates";
import { useUpdatesStore } from "../../state/stores/updates";
import { UpdateSection } from "../settings/panels/about-panel";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

const TONE: Record<Shown["kind"], string> = {
  available: "border-primary/40 bg-primary/15 text-(--state-info-fg) hover:bg-primary/25",
  downloading: "border-primary/40 bg-primary/15 text-(--state-info-fg) hover:bg-primary/25",
  verifying: "border-primary/40 bg-primary/15 text-(--state-info-fg) hover:bg-primary/25",
  ready: "border-primary bg-primary text-primary-foreground hover:bg-primary/85",
  failed: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
};

export function UpdateButton() {
  const { t } = useTranslation(["common", "settings"]);
  const status = useUpdatesStore((s) => s.status);
  const progress = useUpdatesStore((s) => s.progress);
  const ignoredVersion = useUpdatesStore((s) => s.ignoredVersion);
  const [open, setOpen] = useState(false);
  // The Microsoft Store updates its own install.
  const shown =
    window.host?.windowsStore === true ? null : updateButtonOf(status, progress, ignoredVersion);
  if (!shown) return null;

  const Icon =
    shown.kind === "ready" ? RotateCw : shown.kind === "failed" ? TriangleAlert : CircleArrowUp;
  let label: string;
  switch (shown.kind) {
    case "available":
      label = t("updates.button.available", { version: shown.version });
      break;
    case "downloading":
      label =
        shown.percent === undefined
          ? t("updates.button.downloading")
          : t("updates.button.downloadingPercent", { percent: shown.percent });
      break;
    case "verifying":
      label = t("updates.button.verifying");
      break;
    case "ready":
      label = t("updates.button.ready");
      break;
    case "failed":
      label = t("updates.button.failed");
      break;
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={label}
      side="bottom"
      testId="update-popover"
      className="flex w-80 flex-col gap-3 p-3"
      trigger={
        <button
          type="button"
          data-testid="update-button"
          className={cn(
            "app-no-drag mr-1.5 flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2",
            "text-app-ui-sm font-medium tabular-nums transition-colors duration-150",
            TONE[shown.kind],
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span>{label}</span>
        </button>
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-app-body-emphasis text-foreground">NexusCode</span>
        <span className="text-muted-foreground">
          {t("settings:about.version", { version: __APP_VERSION__ })}
        </span>
      </div>
      <UpdateSection status={status} progress={progress}>
        {status?.kind === "newer" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              skipVersion(status.latest);
              setOpen(false);
            }}
          >
            {t("updates.skipVersion")}
          </Button>
        )}
      </UpdateSection>
    </Popover>
  );
}
