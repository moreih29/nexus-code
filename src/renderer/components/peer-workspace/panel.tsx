import { Bot, FileDiff, GitCommitHorizontal, Plus } from "lucide-react";
import { Tabs } from "radix-ui";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
import { fadeMask, useStripOverflow } from "../../hooks/use-strip-overflow";
import { useTabInSight } from "../../hooks/use-tab-in-sight";
import { remoteTitle } from "../../services/remote/display-name";
import { type PeerReach, peerServes } from "../../services/remote/room";
import { returnFromPeerWorkspace } from "../../state/operations/workspace-selection";
import {
  EMPTY_PEER_VIEW,
  type PeerFileTab,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { useUIStore } from "../../state/stores/ui";
import { copyTextViaIpc } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { workspacePathParts } from "../../utils/path";
import { RemoteNewMenu } from "../agent-view/remote-new-menu";
import { type PeerSessionRef, renamePeerSession } from "../agent-view/remote-session-actions";
import { RemoteStateGlyph } from "../agent-view/remote-sessions";
import { FileLookBody, FileLookControls, useFileLookView } from "../chat/file-look";
import { FileIcon } from "../files/file-tree/file-icon";
import { Button } from "../ui/button";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { PromptDialog } from "../ui/prompt-dialog";
import { OverflowTabsMenu } from "../workspace/tabs/overflow-tabs-menu";
import { TabItem } from "../workspace/tabs/tab-item";
import { PeerCommitTabBody } from "./commit-tab";
import { PeerDiffTabBody } from "./diff-tab";
import { peerGitDisplayPath } from "./git-path-label";
import { PeerReadOnlyBadge } from "./labels";
import { showPeerWorkspaceSession } from "./session-placement";
import { PeerSessionTabBody, peerSessionIcons } from "./session-tab";
import { PeerStatusBar } from "./status-bar";
import { peerTabMenu } from "./tab-menu";

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
  const [renaming, setRenaming] = useState<PeerSessionRef | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
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
  const faces = view.tabs.flatMap((tab, index): TabFace[] => {
    const key = peerTabId(tab);
    const value = encodeURIComponent(key);
    if (tab.type === "peer.session") {
      const Icon = peerSessionIcons[tab.target.kind];
      const { kind } = tab.target;
      const title =
        remoteTitle(tab.target.title) ||
        t(
          kind === "terminal"
            ? "terminal.default_title"
            : kind === "claude"
              ? "chat.tab_title"
              : "chat.codex.tab_title",
        );
      return [
        {
          key,
          value,
          label: tab.gone ? `${title} · ${t("peerWorkspace.sessionGone")}` : title,
          icon: <Icon className="size-3.5" aria-hidden="true" />,
          glyph: tab.gone ? undefined : <RemoteStateGlyph target={tab.target} />,
        },
      ];
    }
    if (tab.type === "peer.commit") {
      return [
        {
          key,
          value,
          label: tab.subject || t("editor.commit_title", { sha: tab.hash.slice(0, 7) }),
          icon: <GitCommitHorizontal className="size-3.5" aria-hidden="true" />,
        },
      ];
    }
    const displayPath = names[index];
    if (!displayPath) return [];
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
    const comparison = isDiff ? (tab.side === "staged" ? "HEAD → INDEX" : "INDEX → WORKING") : null;
    return [
      {
        key,
        value,
        label: comparison ? `${display} · ${comparison}` : display,
        icon: isDiff ? (
          <FileDiff className="size-3.5" />
        ) : (
          <FileIcon size="sm" kind="file" name={name} tone="sidebar" />
        ),
        ...(tab.type === "peer.file" ? { path: tab.path } : {}),
      },
    ];
  });
  const stripRef = useRef<HTMLDivElement | null>(null);
  const overflow = useStripOverflow(
    stripRef,
    faces.map((face) => face.value),
    (strip, value) => strip.querySelector(`[data-tab-id="${CSS.escape(value)}"]`),
  );
  useTabInSight(stripRef, view.activePath, (strip) =>
    strip.querySelector('[role="tab"][data-state="active"]'),
  );
  const closeAll = (keys: readonly string[]) => {
    for (const key of keys) close(id, key);
  };
  const menuOf = (index: number) => {
    const face = faces[index];
    const tab = view.tabs.find((each) => peerTabId(each) === face?.key);
    if (!face || !tab) return undefined;
    const keys = faces.map((each) => each.key);
    const session = tab.type === "peer.session" && !tab.gone ? tab.target : undefined;
    const path = face.path;
    return peerTabMenu({
      rename:
        session &&
        reachable &&
        peerServes(peer, session.kind === "terminal" ? "terminal.control" : "chat.control")
          ? () => setRenaming(session)
          : undefined,
      close: () => close(id, face.key),
      closeOthers: () => closeAll(keys.filter((key) => key !== face.key)),
      closeToRight: () => closeAll(keys.slice(index + 1)),
      closeAll: () => closeAll(keys),
      ...(path !== undefined
        ? {
            copyPath: () => void copyTextViaIpc(path),
            copyRelativePath: () => {
              const { directory, fileName } = workspacePathParts(path, root);
              void copyTextViaIpc(`${directory}${fileName}`);
            },
          }
        : {}),
    });
  };

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
                <div
                  ref={stripRef}
                  className="h-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  style={{ maskImage: fadeMask(overflow) }}
                >
                  <Tabs.List
                    aria-label={t("tabBar.open_tabs")}
                    className="flex h-full w-max items-center"
                  >
                    {faces.map((face, index) => (
                      <TabItem
                        key={face.key}
                        readOnly
                        value={face.value}
                        label={face.label}
                        icon={face.icon}
                        glyph={face.glyph}
                        menu={menuOf(index)}
                        onClose={() => close(id, face.key)}
                      />
                    ))}
                  </Tabs.List>
                </div>
                <OverflowTabsMenu
                  hidden={overflow.hidden}
                  renderTab={(value) => {
                    const face = faces.find((each) => each.value === value);
                    return (
                      face && (
                        <>
                          {face.icon}
                          <span className="truncate">{face.label}</span>
                        </>
                      )
                    );
                  }}
                  onSelect={(value) => select(id, decodeURIComponent(value))}
                />
                {reachable && peer && (
                  <RemoteNewMenu
                    peer={peer}
                    workspace={target.workspace}
                    onOpenSession={(session) => showPeerWorkspaceSession(target, session)}
                    terminalFirst
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ml-0 size-8 shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("tabBar.new_tab")}
                        data-testid="remote-new-menu"
                      >
                        <Plus aria-hidden width={16} height={16} strokeWidth={1.5} />
                      </Button>
                    }
                  >
                    <DropdownMenuItem
                      onSelect={() => {
                        usePeerWorkspaceStore.getState().setFilesMode(id, "agents");
                        useUIStore.getState().setPanelHidden("files", false);
                      }}
                    >
                      <Bot aria-hidden className="mr-1.5 size-3.5 shrink-0" />
                      <span className="flex-1">{t("tabBar.agent_list")}</span>
                    </DropdownMenuItem>
                  </RemoteNewMenu>
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
      <PeerStatusBar
        target={target}
        status={status}
        gitError={view.gitError}
        peer={peer}
        active={shown && reachable}
      />
      <PromptDialog
        request={
          renaming && {
            title: t("tabBar.rename_tab"),
            defaultValue: remoteTitle(renaming.title),
            confirmLabel: t("action.save"),
          }
        }
        busy={renameBusy}
        onCancel={() => setRenaming(null)}
        onConfirm={(title) => {
          if (!renaming) return;
          setRenameBusy(true);
          void renamePeerSession(renaming, title).then(() => {
            setRenameBusy(false);
            setRenaming(null);
          });
        }}
      />
    </div>
  );
}

/** A tab's face: its label, icon and state, and a file's path there. */
interface TabFace {
  key: string;
  value: string;
  label: string;
  icon: ReactNode;
  glyph?: ReactNode;
  path?: string;
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
