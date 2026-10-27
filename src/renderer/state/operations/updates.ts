/**
 * Updates IPC subscriptions — main → renderer wiring.
 *
 * Subscribes to `updates.statusChanged` and fires the appropriate Toast
 * variant based on the discriminated-union payload and trigger type.
 *
 * TOAST RULES
 * -----------
 *   kind=checking   (manual only)  → plain info toast, short duration
 *   kind=newer                     → action toast: "Download" + "Skip this version"
 *   kind=current  + trigger=manual → plain info toast 3 s
 *   kind=current  + trigger=auto   → silent
 *   kind=error    + trigger=manual → error toast
 *   kind=error    + trigger=auto   → silent
 *
 * DEDUPE
 * ------
 *   Main already dedupes identical (kind, latest) pairs before broadcasting.
 *   The renderer adds a second guard: it remembers the last `latest` string
 *   it showed a "newer" toast for and skips a second consecutive broadcast
 *   for the same version.  This is belt-and-suspenders protection against
 *   multiple renderer windows receiving the same broadcast.
 *
 * INITIALIZATION
 * --------------
 *   Call `initUpdatesSubscriptions()` once during app bootstrap (after the
 *   IPC bridge is installed).  The function is idempotent — a second call
 *   unsubscribes the previous listener and installs a fresh one (safe for HMR).
 */

import i18next from "i18next";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { showToast } from "../../components/ui/toast";
import { updateCheckFailedMessage } from "./update-check-failure";

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

let activeUnsub: Unsubscribe | null = null;

/** Version string of the last "newer" toast shown. Used for renderer-side dedupe. */
let lastShownNewerVersion: string | null = null;

/**
 * Install (or reinstall) the `updates.statusChanged` → toast subscription.
 *
 * Safe to call multiple times — previous listener is removed first.
 */
export function initUpdatesSubscriptions(): void {
  if (activeUnsub !== null) {
    activeUnsub();
    activeUnsub = null;
  }

  activeUnsub = ipcListen("updates", "statusChanged", (status) => {
    switch (status.kind) {
      case "checking":
        // Only broadcast for manual trigger (main suppresses auto-trigger checking).
        showToast({
          kind: "info",
          message: i18next.t("common:updates.checking"),
          durationMs: 3000,
        });
        break;

      case "newer": {
        // Renderer-side dedupe: skip if we already showed a toast for this version.
        if (status.latest === lastShownNewerVersion) {
          break;
        }
        lastShownNewerVersion = status.latest;

        const { latest, releaseUrl } = status;

        showToast({
          kind: "info",
          message: i18next.t("common:updates.available", { version: latest }),
          actions: [
            {
              label: i18next.t("common:updates.download"),
              onAction: () => {
                void ipcCallResult("updates", "openReleasePage", { url: releaseUrl });
              },
            },
            {
              label: i18next.t("common:updates.skipVersion"),
              onAction: () => {
                void ipcCallResult("updates", "setIgnoredVersion", { version: latest });
              },
            },
          ],
        });
        break;
      }

      case "current":
        // Only show a toast for manual triggers; auto-triggered "current" is silent.
        if (status.trigger === "manual") {
          showToast({
            kind: "info",
            message: i18next.t("common:updates.upToDate"),
            durationMs: 3000,
          });
        }
        break;

      case "error":
        // Only show a toast for manual triggers; auto-triggered errors are silent.
        if (status.trigger === "manual") {
          showToast({
            kind: "error",
            message: updateCheckFailedMessage(status),
          });
        }
        break;
    }
  });
}
