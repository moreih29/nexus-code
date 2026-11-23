import i18next from "i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey, removeKey } from "../../services/agent-view/layout";
import { forgetRemoteResult } from "../../services/agent-view/remote-results";
import { forgetPeerSubmissions } from "../../services/remote/peer-submissions";
import { refreshPeerSessions } from "../../services/remote/room";
import { useAgentViewStore } from "../../state/stores/agent-view";
import {
  type OpenRemoteSession,
  openRemoteSession,
  type RemoteTarget,
} from "../../state/stores/remote-view";
import { showConfirmDialog } from "../ui/confirm-dialog";
import { showToast } from "../ui/toast";

export interface PeerWorkspaceRef {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
}

export type PeerSessionRef = Pick<
  RemoteTarget,
  "deviceId" | "deviceName" | "workspaceId" | "tabId" | "kind" | "title"
>;

function failed(message: string): void {
  showToast({ kind: "error", message: i18next.t("agentView.remote.failed", { message }) });
}

export async function reorderPeerSessions(
  deviceId: string,
  workspaceId: string,
  tabIds: string[],
  preview: (order: readonly string[] | undefined) => void,
): Promise<boolean> {
  preview(tabIds);
  try {
    const result = await ipcCallResult("remote", "peerSessionsReorder", {
      deviceId,
      workspaceId,
      tabIds,
    });
    if (result.ok) return true;
    failed(result.message);
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
  }
  preview(undefined);
  return false;
}

export async function newPeerChat(
  where: PeerWorkspaceRef,
  agent: "claude" | "codex",
  profile?: { id: string; name: string },
  open: OpenRemoteSession = openRemoteSession,
): Promise<boolean> {
  const result = await ipcCallResult("remote", "peerChatNew", {
    deviceId: where.deviceId,
    workspaceId: where.workspaceId,
    agent,
    ...(profile ? { profile: profile.id } : {}),
  });
  if (!result.ok) {
    failed(result.message);
    return false;
  }
  if (result.value.error) failed(result.value.error);
  open({
    ...where,
    tabId: result.value.tabId,
    kind: agent,
    title: i18next.t(agent === "claude" ? "chat.tab_title" : "chat.codex.tab_title"),
    state: "idle",
    ...(profile ? { profile: profile.name } : {}),
  });
  refreshPeerSessions(where.deviceId);
  return true;
}

export async function newPeerTerminal(
  where: PeerWorkspaceRef,
  shell?: { id: string; name: string },
  open: OpenRemoteSession = openRemoteSession,
): Promise<boolean> {
  const result = await ipcCallResult("remote", "peerTerminalOpen", {
    deviceId: where.deviceId,
    workspaceId: where.workspaceId,
    ...(shell ? { shell: shell.id } : {}),
  });
  if (!result.ok) {
    failed(result.message);
    return false;
  }
  open({
    ...where,
    tabId: result.value.tabId,
    kind: "terminal",
    title: shell?.name ?? i18next.t("terminal.default_title"),
    state: "idle",
  });
  refreshPeerSessions(where.deviceId);
  return true;
}

export async function renamePeerSession(session: PeerSessionRef, title: string): Promise<boolean> {
  const ref = {
    deviceId: session.deviceId,
    workspaceId: session.workspaceId,
    tabId: session.tabId,
    title: title.trim().slice(0, 200),
  };
  const result =
    session.kind === "terminal"
      ? await ipcCallResult("remote", "peerTerminalRename", ref)
      : await ipcCallResult("remote", "peerChatRename", ref);
  if (!result.ok) {
    failed(result.message);
    return false;
  }
  refreshPeerSessions(session.deviceId);
  return true;
}

export function runningProgramOf(message: string): string | null {
  return /^(.+?) is running there\b/.exec(message.trim())?.[1] ?? null;
}

export async function closePeerSession(session: PeerSessionRef): Promise<boolean> {
  const terminal = session.kind === "terminal";
  const sure = await showConfirmDialog({
    title: i18next.t(
      terminal ? "agentView.remote.closeTerminalTitle" : "agentView.remote.exitTitle",
      { device: session.deviceName },
    ),
    description: i18next.t(
      terminal ? "agentView.remote.closeTerminalBody" : "agentView.remote.exitBody",
    ),
    confirmLabel: i18next.t("agentView.remote.exitConfirm"),
    variant: "destructive",
  });
  if (!sure) return false;
  const ref = {
    deviceId: session.deviceId,
    workspaceId: session.workspaceId,
    tabId: session.tabId,
  };
  let result: IpcResult<unknown> = terminal
    ? await ipcCallResult("remote", "peerTerminalClose", ref)
    : await ipcCallResult("remote", "peerChatClose", ref);
  const program = !result.ok && terminal ? runningProgramOf(result.message) : null;
  if (program !== null) {
    const anyway = await showConfirmDialog({
      title: i18next.t("terminal.close_running_title"),
      description: i18next.t("terminal.close_running_description", { name: program }),
      confirmLabel: i18next.t("terminal.close_running_confirm"),
      variant: "destructive",
    });
    if (!anyway) return false;
    result = await ipcCallResult("remote", "peerTerminalClose", { ...ref, force: true });
  }
  if (!result.ok && result.kind !== "not-found") {
    failed(result.message);
    return false;
  }
  if (terminal) forgetRemoteResult(ref);
  else forgetPeerSubmissions(ref);
  const key = remoteSessionKey(session);
  useAgentViewStore.getState().update((layout) => removeKey(layout, key));
  refreshPeerSessions(session.deviceId);
  return true;
}
