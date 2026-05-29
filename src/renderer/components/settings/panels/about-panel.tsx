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
// Toast feedback for the manual check is driven by the global
// `initUpdatesSubscriptions()` listener (bootstrap-level) — this component
// does not wire toasts itself, mirroring the previous updates panel.

import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../../ipc/client";
import { useUpdatesStore } from "../../../state/stores/updates";
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

  const autoCheckId = useId();
  const [checking, setChecking] = useState(false);

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

  const handleCheckNow = useCallback(() => {
    if (checking) return;
    setChecking(true);
    void ipcCallResult("updates", "check", { trigger: "manual" }).finally(() => {
      setChecking(false);
    });
  }, [checking]);

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

      {/* Manual check action — small button, left-aligned. */}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckNow}
          disabled={checking}
        >
          {checking ? t("about.checking") : t("about.checkNow")}
        </Button>
      </div>
    </div>
  );
}
