import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../../ipc/client";
import { useNotificationsStore } from "../../../state/stores/notifications";
import { SettingsGroup, SettingsPage, SettingsSwitch } from "../section";

export function NotificationsPanel() {
  const { t } = useTranslation("settings");
  const osEnabled = useNotificationsStore((s) => s.osEnabled);
  const setOsEnabled = useNotificationsStore((s) => s.setOsEnabled);
  const rateLimitWarnings = useNotificationsStore((s) => s.rateLimitWarnings);
  const setRateLimitWarnings = useNotificationsStore((s) => s.setRateLimitWarnings);

  const handleOsToggleChange = useCallback(
    (next: boolean) => {
      setOsEnabled(next);
      void ipcCallResult("appState", "set", { osNotificationsEnabled: next });
    },
    [setOsEnabled],
  );

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingsSwitch
          label={t("notifications.osEnabled.label")}
          description={t("notifications.osEnabled.description")}
          checked={osEnabled}
          onChange={handleOsToggleChange}
        />
        <SettingsSwitch
          label={t("notifications.rateLimitWarnings.label")}
          description={t("notifications.rateLimitWarnings.description")}
          checked={rateLimitWarnings}
          onChange={(next) => {
            setRateLimitWarnings(next);
            void ipcCallResult("appState", "set", { rateLimitWarnings: next });
          }}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
