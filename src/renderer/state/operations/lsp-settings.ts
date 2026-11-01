/**
 * Language server settings → store, and the documents a change turns on.
 *
 * Main broadcasts the settings after every change, from any window. Turning a
 * language on opens the active workspace's documents for it at once; other
 * workspaces catch up when activated. Turning one off needs nothing here:
 * main stops the servers and its workspaceReset broadcast closes the
 * documents.
 */

import { ipcListen } from "../../ipc/client";
import { rehydrateLspForWorkspace } from "../../services/editor/model/cache";
import { useActiveStore } from "../stores/active";
import { useLspSettingsStore } from "../stores/lsp-settings";

let unlisten: (() => void) | null = null;

/** Safe to call more than once — the previous listener is removed first. */
export function initLspSettingsSync(): void {
  unlisten?.();
  unlisten = ipcListen("lsp", "settingsChanged", (settings) => {
    useLspSettingsStore.getState().hydrate(settings);
    const workspaceId = useActiveStore.getState().activeWorkspaceId;
    if (workspaceId) rehydrateLspForWorkspace(workspaceId);
  });
}
