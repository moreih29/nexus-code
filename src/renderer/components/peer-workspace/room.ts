import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomPeer } from "../../../shared/remote/room";
import { orderPeers } from "../../services/agent-view/order";
import { remoteAccountKey, useRemoteAccount } from "../../services/remote/account";
import { watchPeerGitStatus } from "../../services/remote/peer-git-status";
import {
  observePeerSessions,
  offlinePeers,
  type PeerReach,
  servingPeers,
  usePeerSessions,
  useRemoteRoom,
  useShownRoom,
} from "../../services/remote/room";
import { returnFromPeerWorkspace } from "../../state/operations/workspace-selection";
import { useAgentViewStore } from "../../state/stores/agent-view";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";

export function peerTarget(
  accountKey: string,
  peer: RoomPeer,
  workspace: PeerWorkspaceTarget["workspace"],
): PeerWorkspaceTarget {
  return {
    accountKey,
    deviceId: peer.id,
    deviceName: peer.name,
    platform: peer.platform,
    workspaceId: workspace.id,
    workspace,
  };
}

export function usePeerWorkbench(sidebarShown: boolean, workspaceShown: boolean) {
  const account = useRemoteAccount();
  const accountKey = remoteAccountKey(account);
  const active = usePeerWorkspaceStore((state) => state.active);
  const missing = usePeerWorkspaceStore((state) => state.missing);
  const room = useRemoteRoom();
  const shownRoom = useShownRoom(room);
  const order = useAgentViewStore((state) =>
    state.peerOrder?.accountKey === accountKey ? state.peerOrder.ids : undefined,
  );
  const selection = active?.accountKey === accountKey ? active : null;
  const online = accountKey ? orderPeers(servingPeers(shownRoom), order) : [];
  const offline = accountKey ? orderPeers(offlinePeers(shownRoom), order) : [];
  const peer = room?.peers.find(({ id }) => id === selection?.deviceId);
  const shownPeer = shownRoom?.peers.find(({ id }) => id === selection?.deviceId);
  const reachable = room?.status === "online" && peer?.online === true;
  const reach: PeerReach =
    shownRoom?.status !== "online" ? "disconnected" : shownPeer?.online ? "online" : "offline";
  const watched = sidebarShown ? online.map(({ id }) => id) : selection ? [selection.deviceId] : [];
  // Both visible sidebars use the same watch, including the first switch to Agents.
  const lists = usePeerSessions(watched, sidebarShown || (workspaceShown && selection !== null));
  const sessions = selection ? lists[selection.deviceId] : undefined;
  const workspaces = sessions?.status === "ready" ? sessions.list.workspaces : undefined;
  const current = workspaces?.find(({ id }) => id === selection?.workspaceId);
  const gitSupported = peer?.serves?.includes("git") ?? false;
  const rejoin = peer?.rejoins ?? 0;
  const gitTarget = selection ? peerTargetId(selection) : null;
  const deviceId = selection?.deviceId;
  const deviceName = peer?.name;
  const workspaceId = selection?.workspaceId;
  const root = selection?.workspace.path;
  const refresh = useRef<(() => void) | null>(null);
  const refreshGit = useCallback(() => refresh.current?.(), []);
  const [sessionHint, setSessionHint] = useState(0);

  useEffect(() => {
    if (!workspaceShown || !reachable || missing || !gitTarget || !deviceId || !workspaceId) return;
    const watch = watchPeerGitStatus(
      { deviceId, workspaceId },
      {
        gitSupported,
        onResult: (result) => {
          const state = usePeerWorkspaceStore.getState();
          const target = state.active;
          if (target && target.accountKey === accountKey && target.workspace.path === root) {
            state.setGitResult(gitTarget, result);
          }
        },
        onSessionHint: () => setSessionHint((before) => before + 1),
      },
    );
    refresh.current = watch.refresh;
    const off = observePeerSessions(deviceId, rejoin, (sessions) => {
      if (sessions.status !== "ready") return;
      const { workspaces, sessions: listed, incompleteWorkspaces } = sessions.list;
      const incomplete = incompleteWorkspaces?.includes(workspaceId) ?? false;
      watch.updateSessions(listed, incomplete);
      const workspace = workspaces.find(({ id }) => id === workspaceId);
      const state = usePeerWorkspaceStore.getState();
      const target = state.active;
      if (
        workspace &&
        target &&
        peerTargetId(target) === gitTarget &&
        target.accountKey === accountKey
      ) {
        state.syncSessions(
          { ...target, workspace, deviceName: deviceName ?? target.deviceName },
          listed,
          incomplete,
        );
      }
    });
    return () => {
      refresh.current = null;
      off();
      watch.stop();
    };
  }, [
    accountKey,
    deviceId,
    deviceName,
    gitSupported,
    gitTarget,
    missing,
    reachable,
    rejoin,
    root,
    workspaceId,
    workspaceShown,
  ]);

  useEffect(() => {
    if (!account) return;
    if (active && active.accountKey !== accountKey) returnFromPeerWorkspace();
    usePeerWorkspaceStore.getState().setAccount(accountKey);
  }, [account, accountKey, active]);

  useEffect(() => {
    if (!selection || !reachable || !peer || !workspaces || missing) return;
    const store = usePeerWorkspaceStore.getState();
    if (!current) store.markMissing(peerTargetId(selection));
    else if (
      current.name !== selection.workspace.name ||
      current.path !== selection.workspace.path ||
      current.parentId !== selection.workspace.parentId ||
      peer.name !== selection.deviceName ||
      peer.platform !== selection.platform
    ) {
      store.updateTarget(peerTarget(selection.accountKey, peer, current));
    }
  }, [current, missing, peer, reachable, selection, workspaces]);

  return {
    accountKey,
    online,
    offline,
    lists,
    active: selection,
    peer: reachable ? peer : undefined,
    missing,
    reach,
    reachable,
    filesSupported: peer?.serves?.includes("files") ?? false,
    gitSupported,
    refreshGit,
    sessionHint,
    rejoin,
    workspaces,
  };
}
