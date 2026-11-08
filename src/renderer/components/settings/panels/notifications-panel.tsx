// src/renderer/components/settings/panels/notifications-panel.tsx
//
// Notifications panel — single master toggle that gates Electron `Notification`
// emission from the Claude hook handler. When off, the three OS-notification
// pathways (Notification hook, Permission request, Stop / response complete)
// all suppress; in-app status broker (sidebar attention indicator, tab status
// glyph, Claude response preview card) is unaffected because the gate lives
// strictly at the OS-emit boundary in `fireOsNotification`.
//
// This panel currently exposes one switch — masters all three. If the user
// later wants per-event granularity, the AppState field is intentionally
// named `osNotificationsEnabled` (boolean today, expandable to a discriminated
// object later) so the migration stays additive.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../../ipc/client";
import { useManagerStore } from "../../../state/stores/manager";
import { useNotificationsStore } from "../../../state/stores/notifications";
import { SettingsGroup, SettingsPage, SettingsSwitch } from "../section";

export function NotificationsPanel() {
  const { t } = useTranslation("settings");
  const osEnabled = useNotificationsStore((s) => s.osEnabled);
  const setOsEnabled = useNotificationsStore((s) => s.setOsEnabled);
  const rateLimitWarnings = useNotificationsStore((s) => s.rateLimitWarnings);
  const setRateLimitWarnings = useNotificationsStore((s) => s.setRateLimitWarnings);
  const managerReports = useManagerStore((s) => s.reports);
  const setManager = useManagerStore((s) => s.setSettings);

  const handleOsToggleChange = useCallback(
    (next: boolean) => {
      // Optimistic local update so the switch flips immediately.
      setOsEnabled(next);
      // Persist to AppState — main reads via `stateService.getState()` on
      // every hook fire, so the change takes effect on the next hook event
      // without needing process restart.
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
        {/* The agent manager's answers, while the app is not in front. */}
        <SettingsSwitch
          label={t("notifications.managerReports.label")}
          description={t("notifications.managerReports.description")}
          checked={managerReports}
          onChange={(next) => setManager({ reports: next })}
          disabled={!osEnabled}
        />
        {/* In the app, not on the desktop: independent of the switch above. */}
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
