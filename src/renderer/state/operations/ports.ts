// Mirrors main's listening ports (pty:ports) into the ports store, and opens
// one in a browser tab.

import { portUrl } from "../../../shared/pty/ports";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { usePortsStore } from "../stores/ports";
import { useWorkspacesStore } from "../stores/workspaces";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import { openBrowserTabAt } from "./tabs";

let unlisten: (() => void) | null = null;
let unregisterCleanup: (() => void) | null = null;

export function initPortsSync(): void {
  unlisten?.();
  unregisterCleanup?.();
  unlisten = ipcListen("pty", "ports", (entry) => {
    usePortsStore.getState().set(entry);
  });
  unregisterCleanup = registerWorkspaceCleanup((workspaceId) => {
    usePortsStore.getState().set({ workspaceId, ports: [] });
  });
  void ipcCallResult("pty", "ports", {}).then((result) => {
    if (result.ok) usePortsStore.getState().hydrate(result.value);
  });
}

/**
 * Whether the workspace's ports can be opened here. An SSH workspace's
 * servers listen on its host, and the app forwards no ports from there; a
 * WSL distribution's localhost reaches Windows' by default.
 */
export function canOpenPorts(workspaceId: string): boolean {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  return workspace?.location.kind !== "ssh";
}

/** Opens a workspace's port in a new browser tab in that workspace. */
export function openPortInBrowser(workspaceId: string, port: number): void {
  openBrowserTabAt(workspaceId, portUrl(port));
}
