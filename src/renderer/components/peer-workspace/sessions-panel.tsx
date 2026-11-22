import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { OpenRemoteSessionRow } from "../agent-view/remote-sessions";
import { EmptyState } from "../ui/empty-state";
import { showPeerWorkspaceSession } from "./session-placement";

export function PeerSessionsPanel({
  target,
  peer,
}: {
  target: PeerWorkspaceTarget;
  peer?: RoomPeer;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const { sessions, tabs, activePath } = usePeerWorkspaceStore(
    (s) => s.views[id] ?? EMPTY_PEER_VIEW,
  );
  const selected = tabs.find((tab) => peerTabId(tab) === activePath);
  const activeTabId = selected?.type === "peer.session" ? selected.target.tabId : undefined;
  const device = peer ?? {
    id: target.deviceId,
    name: target.deviceName,
    platform: target.platform,
    online: false,
  };

  if (sessions.length === 0) {
    return <EmptyState title={t("peerWorkspace.noSessions")} tone="status" />;
  }
  return (
    <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1 py-1">
      {sessions.map((session) => (
        <OpenRemoteSessionRow
          key={session.tabId}
          session={session}
          peer={device}
          workspace={target.workspace}
          className="w-full"
          aria-current={session.tabId === activeTabId || undefined}
          onOpenSession={(opened) => showPeerWorkspaceSession(target, opened)}
        />
      ))}
    </div>
  );
}
