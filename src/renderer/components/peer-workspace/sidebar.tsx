import { ChevronDown, ChevronRight, Folder, GitBranch, Laptop, Pin, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RemoteSession, RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { toSlashPath } from "../../../shared/fs/drive-path";
import type { RoomPeer } from "../../../shared/remote/room";
import type { PeerSessions } from "../../services/remote/room";
import { selectPeerWorkspace } from "../../state/operations/workspace-selection";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { WorkspaceStatusGlyph } from "../sidebar/workspace-status-glyph";
import { peerTarget } from "./room";
import { peerWorkspacePreview, peerWorkspaceStatus } from "./workspace-status";

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function PeerDeviceIcon({ platform, className }: { platform: string; className: string }) {
  const Icon = platform === "linux" ? Server : Laptop;
  return <Icon aria-hidden="true" className={className} />;
}

interface PeerWorkspaceSectionProps {
  accountKey: string;
  online: readonly RoomPeer[];
  offline: readonly RoomPeer[];
  lists: Readonly<Record<string, PeerSessions>>;
  active: PeerWorkspaceTarget | null;
  missing?: boolean;
  folded: readonly string[];
  toggleFold: (id: string) => void;
}

export function PeerWorkspaceSection({
  accountKey,
  online,
  offline,
  lists,
  active,
  missing,
  folded,
  toggleFold,
}: PeerWorkspaceSectionProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("agentView.remote.title")}>
      <div className="mt-3 px-4 py-1 text-app-label uppercase text-muted-foreground">
        {t("agentView.remote.title")}
      </div>
      {online.map((peer) => {
        const list = lists[peer.id];
        const workspaces =
          list?.status === "ready"
            ? list.list.workspaces.filter(
                ({ id, parentId }) =>
                  !parentId &&
                  !(missing && active?.deviceId === peer.id && active.workspaceId === id),
              )
            : [];
        const expanded = !folded.includes(peer.id);
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
          <div key={peer.id}>
            <button
              type="button"
              aria-expanded={expanded}
              className="mx-2 flex h-[30px] w-[calc(100%-16px)] items-center gap-1.5 rounded-(--radius-control) pr-2 pl-1.5 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
              onClick={() => toggleFold(peer.id)}
            >
              <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <PeerDeviceLabel peer={peer} />
              {list?.status === "ready" && (
                <span className="ml-auto text-app-micro tabular-nums text-muted-foreground">
                  {workspaces.length}
                </span>
              )}
            </button>
            {expanded && (
              <div className="mr-2 ml-[22px] space-y-1">
                {workspaces.map((workspace) => (
                  <PeerWorkspaceRow
                    key={workspace.id}
                    workspace={workspace}
                    family={list?.status === "ready" ? list.list : undefined}
                    selected={
                      active?.deviceId === peer.id &&
                      (active.workspace.parentId ?? active.workspaceId) === workspace.id
                    }
                    onSelect={() => selectPeerWorkspace(peerTarget(accountKey, peer, workspace))}
                  />
                ))}
                {list?.status !== "ready" && (
                  <div className="px-3 py-1 text-app-micro text-muted-foreground">
                    {t(
                      list?.status === "unavailable"
                        ? "peerWorkspace.listUnavailable"
                        : "editor.loading",
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {offline.map((peer) => (
        <div
          key={peer.id}
          className="mx-2 flex h-[30px] items-center gap-1.5 pr-2 pl-6 text-app-ui-sm text-muted-foreground"
        >
          <PeerDeviceLabel peer={peer} />
          <span className="ml-auto shrink-0 text-app-micro">
            {t("agentView.remote.offlineTag")}
          </span>
        </div>
      ))}
    </section>
  );
}

function PeerDeviceLabel({ peer }: { peer: RoomPeer }) {
  return (
    <>
      <PeerDeviceIcon platform={peer.platform} className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate" title={peer.name}>
        {peer.name}
      </span>
      <span className="shrink-0 text-app-micro text-muted-foreground">
        {PLATFORM_NAMES[peer.platform] ?? peer.platform}
      </span>
    </>
  );
}

function PeerWorkspaceRow({
  workspace,
  family,
  selected,
  onSelect,
}: {
  workspace: RemoteWorkspace;
  /** That computer's listing, for the workspace's tasks and sessions. */
  family?: { workspaces: readonly RemoteWorkspace[]; sessions: readonly RemoteSession[] };
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const path = toSlashPath(workspace.path).split("/").filter(Boolean).slice(-2).join("/");
  // The workspace and its tasks, as a local card tells them.
  const ids = new Set([
    workspace.id,
    ...(family?.workspaces ?? []).flatMap(({ id, parentId }) =>
      parentId === workspace.id ? [id] : [],
    ),
  ]);
  const tasks = ids.size - 1;
  const status = family ? peerWorkspaceStatus(family.sessions, ids) : null;
  const preview = family ? peerWorkspacePreview(family.sessions, ids) : null;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "block w-full cursor-pointer select-none rounded-(--radius-control) border-l-2 px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-l-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)] text-foreground"
          : status === "permissionPending"
            ? "border-l-[var(--state-warning-fg)] text-muted-foreground hover:bg-[var(--state-hover-bg)]"
            : status === "error"
              ? "border-l-[var(--state-error-fg)] text-muted-foreground hover:bg-[var(--state-hover-bg)]"
              : "border-l-transparent text-muted-foreground hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <span className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2">
        <span className="mt-0.5 flex flex-col items-center gap-1">
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span
            role="img"
            aria-label={t("peerWorkspace.online")}
            title={t("peerWorkspace.online")}
            className="size-2 rounded-full bg-[var(--color-workspace-connection-connected)] ring-1 ring-background"
          />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "truncate text-app-body-emphasis",
                status === "needsInput" && "font-semibold",
              )}
            >
              {workspace.name}
            </span>
            {workspace.pinned && (
              <span
                role="img"
                aria-label={t("sidebar.pinned")}
                title={t("sidebar.pinned")}
                className="ml-auto inline-flex size-5 shrink-0 items-center justify-center text-[var(--state-selected-indicator)]"
              >
                <Pin className="size-3" fill="currentColor" aria-hidden="true" />
              </span>
            )}
          </span>
          <span className="block truncate text-app-micro opacity-70" title={workspace.path}>
            {path || workspace.path}
          </span>
          {(workspace.git || tasks > 0) && (
            <span className="flex min-w-0 items-center gap-1">
              <PeerWorkspaceBranch git={workspace.git} />
              {tasks > 0 && (
                <span className="shrink-0 whitespace-nowrap text-app-micro opacity-70">
                  {workspace.git?.branch && "· "}
                  {t("sidebar.task_count", { count: tasks })}
                </span>
              )}
            </span>
          )}
          {(status || preview) && (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-app-ui-sm">
              {status && <WorkspaceStatusGlyph status={status} />}
              {preview && <span className="truncate">{preview}</span>}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export function PeerWorkspaceBranch({ git }: { git: RemoteWorkspace["git"] }) {
  const { t } = useTranslation();
  if (!git) return null;
  const changes = git.uncommitted ? t("peerWorkspace.changes", { count: git.uncommitted }) : null;
  const label = [git.branch, changes].filter(Boolean).join(" · ");
  if (!label) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-app-micro opacity-70" title={label}>
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
