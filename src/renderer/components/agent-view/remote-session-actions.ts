/**
 * What the agent view's list does to another computer's sessions, as the
 * user there would: opens a chat or a terminal in one of its workspaces
 * and shows it in a panel, as a click on its row does; renames one; and
 * closes one once the user says so, a terminal still running a program
 * only when they say so again (terminal.close's `force`), its tab here
 * going with it. Each asks the computer's list again, so it shows at once.
 */

import i18next from "i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey, removeKey } from "../../services/agent-view/layout";
import { forgetPeerSubmissions } from "../../services/remote/peer-submissions";
import { refreshPeerSessions } from "../../services/remote/room";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { showConfirmDialog } from "../ui/confirm-dialog";
import { showToast } from "../ui/toast";

/** One of another computer's workspaces, with the names to tell it by. */
export interface PeerWorkspaceRef {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspaceName: string;
  /** Its folder on that computer. */
  path: string;
}

/** A session of another computer's, as its row or tab knows it. */
export type PeerSessionRef = Pick<
  RemoteTarget,
  "deviceId" | "deviceName" | "workspaceId" | "tabId" | "kind" | "title"
>;

function failed(message: string): void {
  showToast({ kind: "error", message: i18next.t("agentView.remote.failed", { message }) });
}

/** Shows the proposed order immediately and clears it if the peer refuses it. */
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

/**
 * Opens a Claude or Codex chat in the workspace there, with `profile`
 * (profiles.list's) or else the one the workspace gives, and shows it in a
 * panel. False when it did not open.
 */
export async function newPeerChat(
  where: PeerWorkspaceRef,
  agent: "claude" | "codex",
  profile?: { id: string; name: string },
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
  // It opened, though something asked of it was not set: said, and shown all the same.
  if (result.value.error) failed(result.value.error);
  useRemoteViewStore.getState().open({
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

/**
 * Opens a terminal in the workspace there, running `shell` (terminal.shells'
 * id) or else its default one, and shows it in a panel. False when it did
 * not open.
 */
export async function newPeerTerminal(
  where: PeerWorkspaceRef,
  shell?: { id: string; name: string },
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
  useRemoteViewStore.getState().open({
    ...where,
    tabId: result.value.tabId,
    kind: "terminal",
    title: shell?.name ?? i18next.t("terminal.default_title"),
    state: "idle",
  });
  refreshPeerSessions(where.deviceId);
  return true;
}

/** Renames the session there, a chat or a terminal. False when it was not renamed. */
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

/**
 * The program a terminal there runs, as its computer says when it will not
 * close it unasked ("vim is running there; add --force to close it
 * anyway"); null for any other refusal.
 */
export function runningProgramOf(message: string): string | null {
  return /^(.+?) is running there\b/.exec(message.trim())?.[1] ?? null;
}

/**
 * Closes the session there once the user says so: a chat's tab, its
 * session kept, as /exit does; a terminal, and one still running a program
 * only when they say so again. Its tab here goes with it, as one already
 * gone there does. False when it stays.
 */
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
  if (!terminal) forgetPeerSubmissions(ref);
  const key = remoteSessionKey(session);
  useAgentViewStore.getState().update((layout) => removeKey(layout, key));
  refreshPeerSessions(session.deviceId);
  return true;
}
