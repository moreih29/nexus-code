import i18next from "i18next";
import { loopbackPort, type PortForward, portUrl } from "../../../shared/pty/ports";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useForwardsStore, usePortsStore } from "../stores/ports";
import { useWorkspacesStore } from "../stores/workspaces";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import { openBrowserTabAt } from "./tabs";

let unlisten: (() => void) | null = null;
let unlistenForwards: (() => void) | null = null;
let unregisterCleanup: (() => void) | null = null;

export function initPortsSync(): void {
  unlisten?.();
  unlistenForwards?.();
  unregisterCleanup?.();
  unlisten = ipcListen("pty", "ports", (entry) => {
    usePortsStore.getState().set(entry);
  });
  unlistenForwards = ipcListen("pty", "forwards", (entry) => {
    useForwardsStore.getState().set(entry);
  });
  unregisterCleanup = registerWorkspaceCleanup((workspaceId) => {
    usePortsStore.getState().set({ workspaceId, ports: [] });
    useForwardsStore.getState().set({ workspaceId, forwards: [] });
  });
  void ipcCallResult("pty", "ports", {}).then((result) => {
    if (result.ok) usePortsStore.getState().hydrate(result.value);
  });
  void ipcCallResult("pty", "forwards", {}).then((result) => {
    if (result.ok) useForwardsStore.getState().hydrate(result.value);
  });
}

export function sshHostOf(workspaceId: string): string | null {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  return workspace?.location.kind === "ssh" ? workspace.location.host : null;
}

export function openPortInBrowser(workspaceId: string, port: number): void {
  openBrowserTabAt(workspaceId, portUrl(port));
}

export function showForwardFailure(
  workspaceId: string,
  port: number,
  kind: string,
  error: string,
): void {
  const message =
    kind === "not-connected"
      ? i18next.t("forward.not_connected", { host: sshHostOf(workspaceId) ?? "", port })
      : i18next.t("forward.failed", { port, error });
  showToast({ kind: "error", message });
}

export async function forwardPort(workspaceId: string, port: number): Promise<PortForward | null> {
  const result = await ipcCallResult("pty", "forward", { workspaceId, port });
  if (result.ok) return result.value;
  showForwardFailure(workspaceId, port, result.kind, result.message);
  return null;
}

export function unforwardPort(workspaceId: string, port: number): void {
  void ipcCallResult("pty", "unforward", { workspaceId, port });
}

export async function portUrlHere(workspaceId: string, port: number): Promise<string | null> {
  if (sshHostOf(workspaceId) === null) return portUrl(port);
  const forward = await forwardPort(workspaceId, port);
  return forward ? portUrl(forward.localPort) : null;
}

export async function localUrlFor(workspaceId: string, url: string): Promise<string | null> {
  const port = loopbackPort(url);
  if (sshHostOf(workspaceId) === null || port === null) return url;
  const result = await ipcCallResult("pty", "localUrl", { workspaceId, url });
  if (result.ok) return result.value.url;
  showForwardFailure(workspaceId, port, result.kind, result.message);
  return null;
}
