import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import { showTerminal } from "../../services/agent-sessions/actions";
import type { SessionTreeNode } from "../../services/agent-sessions/session-tree";
import { useSessionParent } from "../../services/agent-sessions/use-session-parent";
import { remoteDisplayName } from "../../services/remote/display-name";
import { showPeerSession } from "../../services/remote/show-peer";
import { cn } from "../../utils/cn";
import {
  FamilyFold,
  SessionTreeBranch,
  useParentCaption,
  visibleParentName,
} from "../agent-list/session-tree-rows";
import { Button } from "../ui/button";

export interface RemoteTreeNavigation {
  readonly selfId?: string;
  readonly peers: ReadonlyMap<string, RoomPeer>;
  readonly connected: boolean;
}

export interface RemoteRowTree {
  readonly depth: number;
  readonly elsewhere?: RemoteWorkspace;
  readonly parent?: ReactNode;
  readonly family?: ReactNode;
}

export function RemoteSessionBranch({
  root,
  folded,
  searching,
  groupIdle,
  navigation,
  workspaceOf,
  renderRow,
}: {
  root: SessionTreeNode;
  folded: ReadonlySet<string>;
  searching: boolean;
  groupIdle?: boolean;
  navigation?: RemoteTreeNavigation;
  workspaceOf: (workspaceId: string) => RemoteWorkspace | undefined;
  renderRow: (node: SessionTreeNode, tree: RemoteRowTree) => ReactNode;
}) {
  return (
    <SessionTreeBranch
      node={root}
      folded={folded}
      searching={searching}
      groupIdle={groupIdle}
      testPrefix="remote-session"
      renderRow={(node, collapsed) =>
        renderRow(node, {
          depth: node.depth,
          elsewhere:
            node.session.workspaceId !== root.session.workspaceId
              ? workspaceOf(node.session.workspaceId)
              : undefined,
          parent: <RemoteParent node={node} navigation={navigation} />,
          family: node.count > 0 && (
            <FamilyFold
              session={node.session}
              count={node.count}
              collapsed={collapsed}
              counts={node.counts}
              testPrefix="remote-session"
            />
          ),
        })
      }
    />
  );
}

function RemoteParent({
  node,
  navigation,
}: {
  node: SessionTreeNode;
  navigation?: RemoteTreeNavigation;
}) {
  const parentName =
    visibleParentName(node) ??
    (node.depth === 0 && !node.session.parent?.tabId ? node.parentName : undefined);
  if (!parentName && !node.parentClosed) return null;
  return (
    <RemoteParentChip
      name={parentName}
      opener={node.session.parent}
      closed={node.parentClosed}
      navigation={navigation}
    />
  );
}

function RemoteParentChip({
  name,
  opener,
  closed,
  navigation,
}: {
  name?: string;
  opener: SessionTreeNode["session"]["parent"];
  closed?: boolean;
  navigation?: RemoteTreeNavigation;
}) {
  const { t } = useTranslation();
  const device = opener?.device;
  const self = device !== undefined && device.id === navigation?.selfId;
  const peer = device ? navigation?.peers.get(device.id) : undefined;
  const { open } = useSessionParent(self && opener ? { ...opener, device: undefined } : undefined);
  const deviceName = self
    ? t("agentView.list.this_computer")
    : remoteDisplayName(peer?.name ?? device?.name ?? "") || remoteDisplayName(device?.id ?? "");
  const parentName = remoteDisplayName(open?.title) || name;
  const isClosed = closed || (self && !open);
  const label = useParentCaption(
    parentName,
    device ? { id: "", name: deviceName } : undefined,
    isClosed,
  );
  if (!label) return null;
  const closedSuffix = isClosed ? ` · ${t("agentView.list.parent_closed_state")}` : "";
  const hint = device ? label.hint + closedSuffix : label.hint;
  const content = device ? (
    <>
      ↳ <bdi>{deviceName}</bdi> · <bdi>{parentName}</bdi>
      {closedSuffix}
    </>
  ) : (
    label.label
  );
  const { workspaceId, tabId } = opener ?? {};
  const canOpenPeer =
    name && !self && navigation?.connected && peer?.online && workspaceId && tabId;
  const onClick =
    navigation?.connected && open
      ? () => showTerminal(open)
      : canOpenPeer
        ? () =>
            void showPeerSession({
              device: { id: peer.id, name: deviceName },
              workspaceId,
              tabId,
              kind:
                opener?.kind === "terminal"
                  ? "terminal"
                  : opener?.agent === "codex"
                    ? "codex"
                    : "claude",
              title: name,
            })
        : undefined;
  const className = "max-w-40 min-w-0 shrink-[2] truncate text-muted-foreground";
  return onClick ? (
    <Button
      type="button"
      variant="ghost"
      title={hint}
      className={cn(
        className,
        "pointer-events-auto -mx-1 h-4 px-1 py-0 text-app-micro font-normal",
      )}
      data-testid="remote-session-parent"
      onClick={onClick}
    >
      <span className="truncate">{content}</span>
    </Button>
  ) : (
    <span
      className={cn(className, (isClosed || device) && "opacity-70")}
      title={hint}
      data-testid="remote-session-parent"
    >
      {content}
    </span>
  );
}
