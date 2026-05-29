/**
 * Browser permission IPC subscription — main → renderer wiring.
 *
 * Subscribes to the `browserPermission:prompt` broadcast that main sends when
 * a page requests one or more permissions.  Each event enqueues a prompt in
 * the PermissionPromptRoot's queue, which shows the modal.
 *
 * INITIALIZATION
 * --------------
 * Call `initBrowserPermissionSubscriptions()` once during app bootstrap (after
 * the IPC bridge is installed), alongside `initBrowserRuntimeSubscriptions`.
 * The function is idempotent — a second call unsubscribes the previous listener
 * and installs a fresh one (safe for HMR during development).
 */

import { ipcListen } from "../../ipc/client";
import { showPermissionPrompt } from "../../components/ui/permission-prompt-dialog";

type Unsubscribe = () => void;

let activeUnsubs: Unsubscribe[] = [];

/**
 * Install (or reinstall) the browserPermission event → prompt queue subscription.
 *
 * Safe to call multiple times — previous listener is removed first.
 */
export function initBrowserPermissionSubscriptions(): void {
  for (const unsub of activeUnsubs) {
    unsub();
  }
  activeUnsubs = [];

  activeUnsubs.push(
    ipcListen("browserPermission", "prompt", (payload) => {
      showPermissionPrompt(payload);
    }),
  );
}
