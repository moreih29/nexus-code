import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  workspaceLabel,
  renderRow,
}: {
  root: SessionTreeNode;
  folded: ReadonlySet<string>;
  searching: boolean;
  groupIdle?: boolean;
  navigation?: RemoteTreeNavigation;
  workspaceLabel: (workspaceId: string) => string | undefined;
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
            branch={
              node.session.workspaceId !== root.session.workspaceId
                ? workspaceLabel(node.session.workspaceId)
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
  branch,
}: {
  node: SessionTreeNode;
  collapsed: boolean;
  navigation?: RemoteTreeNavigation;
  branch?: string;
}) {
  const parentName = visibleParentName(node);
  const { count, counts, session, parentClosed } = node;
  if (!parentName && !count && !branch) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1 text-app-micro">
      {branch && (
        <span
          className="flex max-w-[45%] min-w-0 items-center gap-0.5 rounded-full border border-border px-1.5 font-mono text-muted-foreground"
          title={remoteDisplayName(branch)}
        >
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{remoteDisplayName(branch)}</span>
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
    ? t("systemStats.this_computer")
    : remoteDisplayName(peer?.name ?? device?.name ?? "") || remoteDisplayName(device?.id ?? "");
  const label = useParentCaption(
    (open && remoteDisplayName(open.title)) || name,
    device ? { id: "", name: deviceName } : undefined,
    closed,
  );
  if (!label) return null;
  const { workspaceId, tabId } = opener ?? {};
  const canOpenPeer = !self && navigation?.connected && peer?.online && workspaceId && tabId;
  const onClick = open
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
      title={label.hint}
      className={cn(className, "h-auto max-w-full px-1 py-0 text-app-micro font-normal")}
      data-testid="remote-session-parent"
      onClick={onClick}
    >
      <span className="truncate">{label.label}</span>
    </Button>
  ) : (
    <span
      className={cn(className, (closed || device) && "opacity-70")}
      title={label.hint}
      data-testid="remote-session-parent"
    >
      {label.label}
    </span>
  );
}
