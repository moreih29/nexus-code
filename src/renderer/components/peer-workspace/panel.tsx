import { FileDiff, GitBranch, GitCommitHorizontal, Lock } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
import type { PeerReach } from "../../services/remote/room";
import { returnFromPeerWorkspace } from "../../state/operations/workspace-selection";
import {
  EMPTY_PEER_VIEW,
  type PeerFileTab,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { workspacePathParts } from "../../utils/path";
import { RemoteNewMenu } from "../agent-view/remote-new-menu";
import { FileLookBody, FileLookControls, useFileLookView } from "../chat/file-look";
import { FileIcon } from "../files/file-tree/file-icon";
import { EmptyState } from "../ui/empty-state";
import { TabItem } from "../workspace/tabs/tab-item";
import { PeerCommitTabBody } from "./commit-tab";
import { PeerDiffTabBody } from "./diff-tab";
import { peerGitDisplayPath } from "./git-path-label";
import { PeerReadOnlyBadge } from "./labels";
import { showPeerWorkspaceSession } from "./session-placement";
import { PeerSessionTabBody, peerSessionIcons } from "./session-tab";
import { PeerDeviceIcon } from "./sidebar";

export function PeerWorkspacePanel({
  target,
  peer,
  shown,
  reach,
  reachable,
  missing,
  updateNeeded,
  gitUpdateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  peer?: RoomPeer;
  shown: boolean;
  reach: PeerReach;
  reachable: boolean;
  missing: boolean;
  updateNeeded: boolean;
  gitUpdateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const view = usePeerWorkspaceStore((s) => s.views[id] ?? EMPTY_PEER_VIEW);
  const select = usePeerWorkspaceStore((s) => s.selectTab);
  const close = usePeerWorkspaceStore((s) => s.closeTab);
  const banner =
    reach === "offline"
      ? t("peerWorkspace.offlineLast", { device: target.deviceName })
      : reach === "disconnected"
        ? t("peerWorkspace.disconnectedLast")
        : null;
  const root = target.workspace.path;
  const status = gitUpdateNeeded ? undefined : view.gitStatus;
  const names = view.tabs.map((tab) => {
    if (tab.type === "peer.commit" || tab.type === "peer.session") return null;
    return tab.type === "peer.diff"
      ? peerGitDisplayPath(root, tab.path, status?.topLevel)
      : { ...workspacePathParts(tab.path, root), outsideWorkspace: false };
  });
  const canReadGit = shown && reachable && !gitUpdateNeeded;

  return (
    <div
      className={cn(
        "col-start-1 row-start-1 min-h-0 min-w-0 flex-col overflow-hidden",
        shown ? "flex" : "hidden",
      )}
    >
      <div className="island-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--radius-island)">
        {missing ? (
          <EmptyState
            title={t("peerWorkspace.missingWorkspace")}
            actionLabel={t("peerWorkspace.returnLocal")}
            onAction={returnFromPeerWorkspace}
            tone="status"
            className="flex-1"
          />
        ) : (
          <>
            {banner && (
              <div
                role="status"
                className="border-b border-border px-2 py-1 text-app-ui-sm text-[var(--state-warning-fg)]"
              >
                {banner}
              </div>
            )}
            <Tabs.Root
              value={view.activePath === null ? "" : encodeURIComponent(view.activePath)}
              onValueChange={(value) => select(id, decodeURIComponent(value))}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex h-9 shrink-0 items-center px-1.5">
                <div className="app-scrollbar h-full min-w-0 overflow-x-auto [scrollbar-width:none]">
                  <Tabs.List
                    aria-label={t("tabBar.open_tabs")}
                    className="flex h-full w-max items-center"
                  >
                    {view.tabs.map((tab, index) => {
                      const key = peerTabId(tab);
                      if (tab.type === "peer.session") {
                        const Icon = peerSessionIcons[tab.target.kind];
                        const { kind } = tab.target;
                        const title =
                          tab.target.title ||
                          t(
                            kind === "terminal"
                              ? "terminal.default_title"
                              : kind === "claude"
                                ? "chat.tab_title"
                                : "chat.codex.tab_title",
                          );
                        return (
                          <TabItem
                            key={key}
                            readOnly
                            value={encodeURIComponent(key)}
                            label={
                              tab.gone ? `${title} · ${t("peerWorkspace.sessionGone")}` : title
                            }
                            icon={<Icon className="size-3.5" aria-hidden="true" />}
                            onClose={() => close(id, key)}
                          />
                        );
                      }
                      if (tab.type === "peer.commit") {
                        return (
                          <TabItem
                            key={key}
                            readOnly
                            value={encodeURIComponent(key)}
                            label={
                              tab.subject || t("editor.commit_title", { sha: tab.hash.slice(0, 7) })
                            }
                            icon={<GitCommitHorizontal className="size-3.5" aria-hidden="true" />}
                            onClose={() => close(id, key)}
                          />
                        );
                      }
                      const displayPath = names[index];
                      if (!displayPath) return null;
                      const { fileName: name, directory, outsideWorkspace } = displayPath;
                      const isDiff = tab.type === "peer.diff";
                      const duplicate = view.tabs.some(
                        (other, at) =>
                          index !== at &&
                          other.type === tab.type &&
                          names[at]?.fileName === name &&
                          names[at]?.outsideWorkspace === outsideWorkspace,
                      );
                      const display = [
                        name,
                        duplicate ? directory.replace(/\/$/, "") || "." : null,
                        outsideWorkspace ? t("peerWorkspace.gitOutsideWorkspace") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const comparison = isDiff
                        ? tab.side === "staged"
                          ? "HEAD → INDEX"
                          : "INDEX → WORKING"
                        : null;
                      return (
                        <TabItem
                          key={key}
                          readOnly
                          value={encodeURIComponent(key)}
                          label={comparison ? `${display} · ${comparison}` : display}
                          icon={
                            isDiff ? (
                              <FileDiff className="size-3.5" />
                            ) : (
                              <FileIcon size="sm" kind="file" name={name} tone="sidebar" />
                            )
                          }
                          onClose={() => close(id, key)}
                        />
                      );
                    })}
                  </Tabs.List>
                </div>
                {reachable && peer && (
                  <RemoteNewMenu
                    peer={peer}
                    workspace={target.workspace}
                    onOpenSession={(session) => showPeerWorkspaceSession(target, session)}
                  />
                )}
              </div>
              {view.tabs.length === 0 && (
                <EmptyState
                  title={t(
                    updateNeeded ? "peerWorkspace.updateNeeded" : "peerWorkspace.selectFile",
                  )}
                  tone="status"
                  className="flex-1"
                />
              )}
              {view.tabs.map((tab) => {
                const key = peerTabId(tab);
                const selected = key === view.activePath;
                if (tab.type === "peer.session") {
                  return (
                    <PeerSessionTabBody
                      key={key}
                      workspace={target}
                      tab={tab}
                      selected={selected}
                      shown={shown}
                    />
                  );
                }
                if (tab.type === "peer.commit") {
                  return (
                    <PeerCommitTabBody
                      key={key}
                      target={target}
                      tab={tab}
                      selected={selected}
                      canRead={canReadGit}
                      updateNeeded={gitUpdateNeeded}
                      rejoin={rejoin}
                    />
                  );
                }
                return tab.type === "peer.diff" ? (
                  <PeerDiffTabBody
                    key={key}
                    target={target}
                    tab={tab}
                    latest={status?.files.find((file) => file.path === tab.path)}
                    topLevel={status?.topLevel}
                    selected={selected}
                    canRead={canReadGit}
                    updateNeeded={gitUpdateNeeded}
                    rejoin={rejoin}
                  />
                ) : (
                  <PeerFileTabBody
                    key={key}
                    id={id}
                    path={tab.path}
                    root={root}
                    at={tab.at}
                    selected={selected}
                    canRead={shown && reachable && !updateNeeded}
                    updateNeeded={updateNeeded}
                    rejoin={rejoin}
                  />
                );
              })}
            </Tabs.Root>
          </>
        )}
      </div>
      <div
        role="status"
        aria-label={t("statusBar.aria")}
        className="flex h-6 shrink-0 items-center gap-1.5 px-2 text-app-micro text-[var(--status-bar-fg)]"
      >
        <PeerDeviceIcon platform={target.platform} className="size-3 shrink-0" />
        <span className="truncate">{target.deviceName}</span>
        <span aria-hidden="true">·</span>
        <Lock className="size-3 shrink-0 text-[var(--state-warning-fg)]" aria-hidden="true" />
        <span className="shrink-0 text-[var(--state-warning-fg)]">
          {t("peerWorkspace.readOnly")}
        </span>
        {status && (
          <>
            <span aria-hidden="true">·</span>
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate" title={status.branch ?? undefined}>
              {status.branch ?? t("peerWorkspace.gitDetached")}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className="shrink-0"
              title={status.truncated ? t("peerWorkspace.gitTruncated") : undefined}
            >
              {t("peerWorkspace.changes", { count: status.files.length })}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function PeerFileTabBody({
  id,
  path,
  root,
  at,
  selected,
  canRead,
  updateNeeded,
  rejoin,
}: {
  id: string;
  path: string;
  root: string;
  at?: PeerFileTab["at"];
  selected: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const show = selected && canRead;
  const [loaded, setLoaded] = useState(show);
  if (show && !loaded) setLoaded(true);
  const view = useFileLookView(path, { at });
  const [lastLocation, setLastLocation] = useState(at);
  if (at !== lastLocation) {
    setLastLocation(at);
    if (at) view.setMode("raw");
  }
  const { directory, fileName } = workspacePathParts(path, root);
  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(path)}
      className={cn("min-h-0 flex-1", !selected && "hidden")}
    >
      {updateNeeded ? (
        <EmptyState title={t("peerWorkspace.updateNeeded")} tone="status" className="h-full" />
      ) : (
        (loaded || show) && (
          <FileLookBody
            workspaceId={id}
            path={path}
            root={root}
            at={at}
            view={view}
            peerFile={{
              watch: show,
              connection: rejoin,
              toolbar: (
                <>
                  <span className="flex min-w-0 flex-1 items-center text-app-ui-sm" title={path}>
                    <span className="truncate text-muted-foreground">{directory}</span>
                    <span className="truncate">{fileName}</span>
                  </span>
                  <FileLookControls path={path} view={view} />
                  <PeerReadOnlyBadge />
                </>
              ),
            }}
          />
        )
      )}
    </Tabs.Content>
  );
}
