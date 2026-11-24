import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../../ipc/client";
import { useSettingsUIStore } from "../../../state/stores/settings-ui";
import { useUpdatesStore } from "../../../state/stores/updates";
import { type BannerDismiss, BannerDismissButton } from "../../ui/banner";
import { Button } from "../../ui/button";
import { SettingsGroup } from "../section";
import { UpdateSection } from "./about-panel";

export function OutdatedGroup() {
  const { t } = useTranslation("settings");
  const status = useUpdatesStore((s) => s.status);
  const progress = useUpdatesStore((s) => s.progress);
  const checking = useUpdatesStore((s) => s.checking);
  const storeManaged = window.host?.windowsStore === true;
  return (
    <SettingsGroup
      title={t("remote.outdated.title")}
      description={t("remote.outdated.description")}
    >
      <div data-testid="remote-outdated-group">
        {storeManaged ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-app-ui-sm text-muted-foreground">{t("about.storeManaged")}</p>
            <Button
              size="sm"
              onClick={() => void ipcCallResult("updates", "openStorePage", undefined)}
            >
              {t("about.openStore")}
            </Button>
          </div>
        ) : (
          <UpdateSection
            status={status}
            progress={progress}
            checking={checking}
            releaseNotes={false}
          />
        )}
      </div>
    </SettingsGroup>
  );
}

export function OutdatedLine({ dismiss }: { dismiss: BannerDismiss }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 px-2 py-1" data-testid="remote-outdated">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-(--state-warning-fg)" />
      <span className="min-w-0 flex-1 text-app-ui-sm text-muted-foreground">
        {t("agentView.remote.outdated")}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 px-2 text-app-micro"
        onClick={() => useSettingsUIStore.getState().openSettingsAt("remote")}
      >
        {t("updates.install")}
      </Button>
      <BannerDismissButton dismiss={dismiss} />
    </div>
  );
}
