import { Lock } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PeerReach } from "../../services/remote/room";
import { returnFromPeerWorkspace } from "../../state/operations/workspace-selection";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { workspacePathParts } from "../../utils/path";
import { FileLookBody, FileLookControls, useFileLookView } from "../chat/file-look";
import { FileIcon } from "../files/file-tree/file-icon";
import { EmptyState } from "../ui/empty-state";
import { TabItem } from "../workspace/tabs/tab-item";
import { PeerReadOnlyBadge } from "./labels";
import { PeerDeviceIcon } from "./sidebar";

export function PeerWorkspacePanel({
  target,
  shown,
  reach,
  reachable,
  missing,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  shown: boolean;
  reach: PeerReach;
  reachable: boolean;
  missing: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const view = usePeerWorkspaceStore((s) => s.views[id] ?? EMPTY_PEER_VIEW);
  const open = usePeerWorkspaceStore((s) => s.openFile);
  const close = usePeerWorkspaceStore((s) => s.closeFile);
  const banner =
    reach === "offline"
      ? t("peerWorkspace.offlineLast", { device: target.deviceName })
      : reach === "disconnected"
        ? t("peerWorkspace.disconnectedLast")
        : null;
  const root = target.workspace.path;
  const filenames = view.tabs.map(({ path }) => workspacePathParts(path, root).fileName);

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
            {updateNeeded ? (
              <EmptyState
                title={t("peerWorkspace.updateNeeded")}
                tone="status"
                className="flex-1"
              />
            ) : view.tabs.length === 0 ? (
              <EmptyState title={t("peerWorkspace.selectFile")} tone="status" className="flex-1" />
            ) : (
              <Tabs.Root
                value={view.activePath === null ? "" : encodeURIComponent(view.activePath)}
                onValueChange={(value) => open(id, decodeURIComponent(value))}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="app-scrollbar h-9 shrink-0 overflow-x-auto px-1.5 [scrollbar-width:none]">
                  <Tabs.List
                    aria-label={t("tabBar.open_tabs")}
                    className="flex h-full w-max items-center"
                  >
                    {view.tabs.map(({ path }, index) => {
                      const name = filenames[index];
                      const duplicate = filenames.indexOf(name) !== filenames.lastIndexOf(name);
                      const label = duplicate
                        ? `${name} · ${workspacePathParts(path, root).directory.replace(/\/$/, "") || "."}`
                        : name;
                      return (
                        <TabItem
                          key={path}
                          readOnly
                          value={encodeURIComponent(path)}
                          label={label}
                          icon={<FileIcon size="sm" kind="file" name={name} tone="sidebar" />}
                          onClose={() => close(id, path)}
                        />
                      );
                    })}
                  </Tabs.List>
                </div>
                {view.tabs.map(({ path }) => (
                  <PeerFileTabBody
                    key={path}
                    id={id}
                    path={path}
                    root={root}
                    selected={path === view.activePath}
                    canRead={shown && reachable}
                    rejoin={rejoin}
                  />
                ))}
              </Tabs.Root>
            )}
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
      </div>
    </div>
  );
}

function PeerFileTabBody({
  id,
  path,
  root,
  selected,
  canRead,
  rejoin,
}: {
  id: string;
  path: string;
  root: string;
  selected: boolean;
  canRead: boolean;
  rejoin: number;
}) {
  const show = selected && canRead;
  const [loaded, setLoaded] = useState(show);
  if (show && !loaded) setLoaded(true);
  const view = useFileLookView(path, {});
  const { directory, fileName } = workspacePathParts(path, root);
  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(path)}
      className={cn("min-h-0 flex-1", !selected && "hidden")}
    >
      {(loaded || show) && (
        <FileLookBody
          workspaceId={id}
          path={path}
          root={root}
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
      )}
    </Tabs.Content>
  );
}
