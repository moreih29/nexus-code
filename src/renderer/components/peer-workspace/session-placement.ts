import type { LineAt } from "../../services/chat/links";
import { requestTabFocus } from "../../services/tab-focus";
import { isAgentViewShown } from "../../state/stores/agent-view";
import {
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import type { RemoteTarget } from "../../state/stores/remote-view";

export function peerSessionFocusKey(workspace: PeerWorkspaceTarget, tabId: string): string {
  return JSON.stringify(["peer.session", workspace.accountKey, peerTargetId(workspace), tabId]);
}

function stillSelected(workspace: PeerWorkspaceTarget): boolean {
  const { active, missing } = usePeerWorkspaceStore.getState();
  return (
    active !== null &&
    !missing &&
    active.accountKey === workspace.accountKey &&
    peerTargetId(active) === peerTargetId(workspace)
  );
}

export function showPeerWorkspaceSession(workspace: PeerWorkspaceTarget, target: RemoteTarget) {
  if (!stillSelected(workspace) || peerTargetId(workspace) !== peerTargetId(target)) return;
  const store = usePeerWorkspaceStore.getState();
  store.openSession(peerTargetId(workspace), target);
  if (target.kind !== "terminal" && !isAgentViewShown()) {
    requestTabFocus(peerSessionFocusKey(workspace, target.tabId));
  }
}

export function hidePeerWorkspaceSession(workspace: PeerWorkspaceTarget, target: RemoteTarget) {
  if (!stillSelected(workspace)) return;
  usePeerWorkspaceStore
    .getState()
    .closeTab(peerTargetId(workspace), peerTabId({ type: "peer.session", target }));
}

export function markPeerWorkspaceSessionGone(workspace: PeerWorkspaceTarget, target: RemoteTarget) {
  if (!stillSelected(workspace)) return;
  usePeerWorkspaceStore.getState().markSessionGone(peerTargetId(workspace), target.tabId);
}

export function openPeerWorkspaceFileBeside(
  workspace: PeerWorkspaceTarget,
  path: string,
  at?: LineAt,
): boolean {
  if (!stillSelected(workspace) || isAgentViewShown()) return false;
  usePeerWorkspaceStore.getState().openFile(peerTargetId(workspace), path, at);
  return true;
}
