import { Folder, GitBranch } from "lucide-react";
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
  StateSummary,
  useParentCaption,
  visibleParentName,
} from "../agent-list/session-tree-rows";
import { Button } from "../ui/button";

export interface RemoteTreeNavigation {
  readonly selfId?: string;
  readonly peers: ReadonlyMap<string, RoomPeer>;
  readonly connected: boolean;
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
  renderRow: (node: SessionTreeNode) => ReactNode;
}) {
  return (
    <SessionTreeBranch
      node={root}
      folded={folded}
      searching={searching}
      groupIdle={groupIdle}
      testPrefix="remote-session"
      renderRow={(node, collapsed) => (
        <>
          {renderRow(node)}
          <RemoteSessionRelations
            node={node}
            collapsed={collapsed}
            navigation={navigation}
            workspace={
              node.session.workspaceId !== root.session.workspaceId
                ? workspaceOf(node.session.workspaceId)
                : undefined
            }
          />
        </>
      )}
    />
  );
}

function RemoteSessionRelations({
  node,
  collapsed,
  navigation,
  workspace,
}: {
  node: SessionTreeNode;
  collapsed: boolean;
  navigation?: RemoteTreeNavigation;
  workspace?: RemoteWorkspace;
}) {
  const parentName =
    visibleParentName(node) ??
    (node.depth === 0 && !node.session.parent?.tabId ? node.parentName : undefined);
  const task = workspace?.parentId !== undefined;
  const workspaceLabel = remoteDisplayName(
    task ? (workspace?.git?.branch ?? workspace?.name) : workspace?.name,
  );
  const WorkspaceIcon = task ? GitBranch : Folder;
  const { count, counts, session, parentClosed } = node;
  if (!parentName && !count && !workspaceLabel) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1 text-app-micro">
      {workspaceLabel && (
        <span
          className="flex max-w-[45%] min-w-0 items-center gap-0.5 rounded-full border border-border px-1.5 font-mono text-muted-foreground"
          title={workspaceLabel}
        >
          <WorkspaceIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{workspaceLabel}</span>
        </span>
      )}
      {parentName && (
        <RemoteParentChip
          name={parentName}
          opener={session.parent}
          closed={parentClosed}
          navigation={navigation}
        />
      )}
      {count > 0 && (
        <FamilyFold
          session={session}
          count={count}
          collapsed={collapsed}
          testPrefix="remote-session"
        />
      )}
      {collapsed && <StateSummary counts={counts} compact testPrefix="remote-session" />}
    </div>
  );
}

function RemoteParentChip({
  name,
  opener,
  closed,
  navigation,
}: {
  name: string;
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
  const canOpenPeer = !self && navigation?.connected && peer?.online && workspaceId && tabId;
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
  const className = "min-w-0 truncate text-muted-foreground";
  return onClick ? (
    <Button
      type="button"
      variant="ghost"
      title={hint}
      className={cn(className, "h-auto max-w-full px-1 py-0 text-app-micro font-normal")}
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
