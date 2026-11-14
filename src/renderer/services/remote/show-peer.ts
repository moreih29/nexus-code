/**
 * Shows a session of another computer of the user's in the agent view, as
 * its list's Other computers does, from what a message it sent tells: its
 * device and tab. Its workspace's name and folder come from that computer's
 * list when it answers; its ids otherwise.
 */
import { ipcCallResult } from "../../ipc/client";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useRemoteViewStore } from "../../state/stores/remote-view";

export interface PeerSessionRef {
  readonly device: { readonly id: string; readonly name: string };
  readonly workspaceId: string;
  readonly tabId: string;
  readonly kind: "claude" | "codex" | "terminal";
  readonly title: string;
}

export async function showPeerSession(ref: PeerSessionRef): Promise<void> {
  const listed = await ipcCallResult("remote", "peerSessions", { deviceId: ref.device.id });
  const workspace = listed.ok
    ? listed.value.workspaces.find((w) => w.id === ref.workspaceId)
    : undefined;
  const session = listed.ok
    ? listed.value.sessions.find((s) => s.workspaceId === ref.workspaceId && s.tabId === ref.tabId)
    : undefined;
  useAgentViewStore.getState().setMode("agents");
  useRemoteViewStore.getState().show({
    deviceId: ref.device.id,
    deviceName: ref.device.name,
    workspaceId: ref.workspaceId,
    workspaceName: workspace?.name ?? ref.workspaceId.slice(0, 8),
    path: workspace?.path ?? "",
    tabId: ref.tabId,
    kind: session?.kind ?? ref.kind,
    title: session?.title ?? ref.title,
  });
}
