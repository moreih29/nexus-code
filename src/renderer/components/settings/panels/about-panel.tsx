// src/renderer/components/settings/panels/about-panel.tsx
//
// About / Info panel — replaces the previous Updates panel.
//
// Shows the product name, the app version (injected at build time via the
// `__APP_VERSION__` Vite define — see `electron.vite.config.ts`), the
// copyright line, and a single "Check for Updates" action.
//
// The Update Channel SegmentedControl (stable / beta) is intentionally not
// rendered at this stage: no GA release exists yet, so a channel toggle has
// no effect for end users. The backend updates domain (poller, AppState
// `updateChannel`, NEXUS_CHANNEL build constant, SSH agent root split) is
// preserved untouched so that surfacing the toggle later only needs a
// re-introduced control here.
//
// Toast feedback for the manual check is driven by the global
// `initUpdatesSubscriptions()` listener (bootstrap-level) — this component
// does not wire toasts itself, mirroring the previous updates panel.

import { useCallback, useState } from "react";
import { ipcCallResult } from "../../../ipc/client";
import { Button } from "../../ui/button";

// ---------------------------------------------------------------------------
// Static product metadata
// ---------------------------------------------------------------------------

const APP_NAME = "NexusCode";
const COPYRIGHT = "Copyright © 2026 moreih29";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AboutPanel() {
  const [checking, setChecking] = useState(false);

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
      <div className="mt-4">
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
