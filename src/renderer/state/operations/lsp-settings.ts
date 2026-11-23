import { ipcListen } from "../../ipc/client";
import { rehydrateLspForWorkspace } from "../../services/editor/model/cache";
import { useActiveStore } from "../stores/active";
import { useLspSettingsStore } from "../stores/lsp-settings";

let unlisten: (() => void) | null = null;

export function initLspSettingsSync(): void {
  unlisten?.();
  unlisten = ipcListen("lsp", "settingsChanged", (settings) => {
    useLspSettingsStore.getState().hydrate(settings);
    const workspaceId = useActiveStore.getState().activeWorkspaceId;
    if (workspaceId) rehydrateLspForWorkspace(workspaceId);
  });
}
