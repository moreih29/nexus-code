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

import { useCallback, useId } from "react";
import { ipcCallResult } from "../../../ipc/client";
import { useNotificationsStore } from "../../../state/stores/notifications";
import { Switch } from "../../ui/switch";

export function NotificationsPanel() {
  const osEnabled = useNotificationsStore((s) => s.osEnabled);
  const setOsEnabled = useNotificationsStore((s) => s.setOsEnabled);

  const osToggleId = useId();

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
    <div className="flex flex-col gap-6">
      {/* Row: stacked label + helper on the left, Switch pinned right —
          mirrors the macOS / VSCode settings pattern used elsewhere in
          this app. items-start so the switch lines up with the title row,
          not the bottom of the helper text. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <label
            htmlFor={osToggleId}
            className="text-app-body text-foreground cursor-pointer"
          >
            Show desktop notifications
          </label>
          <p className="text-app-ui-sm text-muted-foreground">
            When Claude needs your attention (response complete, permission
            request, or a notification hook), the app surfaces an OS-level
            desktop notification — but only while you are not viewing that
            tab. In-app indicators (sidebar attention dot, response preview)
            remain regardless.
          </p>
        </div>
        <Switch
          id={osToggleId}
          checked={osEnabled}
          onCheckedChange={handleOsToggleChange}
          className="shrink-0 mt-1"
        />
      </div>
    </div>
  );
}
