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
import { ipcCallResult } from "../../../ipc/client";
import { useUpdatesStore } from "../../../state/stores/updates";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";

// ---------------------------------------------------------------------------
// Static product metadata
// ---------------------------------------------------------------------------

const APP_NAME = "NexusCode";
const COPYRIGHT = "Copyright © 2026 moreih29";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AboutPanel() {
  const autoCheckEnabled = useUpdatesStore((s) => s.autoCheckEnabled);
  const setAutoCheckEnabled = useUpdatesStore((s) => s.setAutoCheckEnabled);

  const autoCheckId = useId();
  const [checking, setChecking] = useState(false);

  const handleAutoCheckChange = useCallback(
    (next: boolean) => {
      // Optimistic local update so the checkbox flips immediately.
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
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="text-app-body-emphasis text-foreground">{APP_NAME}</div>
      <div className="text-app-body text-muted-foreground">Version {__APP_VERSION__}</div>
      <div className="text-app-ui-sm text-muted-foreground">{COPYRIGHT}</div>

      <label
        htmlFor={autoCheckId}
        className="mt-6 flex items-center gap-2 cursor-pointer"
      >
        <Checkbox
          id={autoCheckId}
          checked={autoCheckEnabled}
          onCheckedChange={(v) => handleAutoCheckChange(v === true)}
        />
        <span className="text-app-body text-foreground">
          Automatically check for updates on startup
        </span>
      </label>

      <div className="mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckNow}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check for Updates"}
        </Button>
      </div>
    </div>
  );
}
