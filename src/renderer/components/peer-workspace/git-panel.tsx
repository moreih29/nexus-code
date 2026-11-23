import { GitBranch } from "lucide-react";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_GIT_EXPANDED_TREE_NODES,
  type GitExpandedGroupKey,
  type GitExpandedTreeNodes,
  type GitPanelSegment,
  type GitStatusEntry,
} from "../../../shared/git/types";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL, type ViewMode } from "../../../shared/types/panel";
import { peerGitPaths } from "../../services/remote/peer-git-paths";
import type { PeerGitFile, PeerGitSide } from "../../services/remote/peer-git-status";
import { dirsFromEntries } from "../../state/stores/git/panel-ui";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { copyText } from "../../utils/clipboard";
import {
  type GitContextMenuPoint,
  GitFileContextMenu,
  type GitFileContextMenuActions,
} from "../files/git/file-row/file-context-menu";
import { GitGroup, type GitGroupActions } from "../files/git/file-row/group";
import { gitFileMenuActions } from "../files/git/file-row/row";
import { HistorySegmentToggle } from "../files/git/history/segment-toggle";
import { GitHeaderBar } from "../files/git/panel/header-bar";
import { EmptyState } from "../ui/empty-state";
import { KeptMounted } from "../ui/kept-mounted";
import { PEER_GIT_GROUPS, type PeerGitGroupKey, peerGitGroups } from "./git-groups";
import { PeerGitHistory } from "./git-history";
import { PeerReadOnlyBadge } from "./labels";

interface PeerGitPanelProps {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  updateNeeded: boolean;
  refresh: () => void;
  rejoin: number;
}

export function PeerGitPanel({ rejoin, ...props }: PeerGitPanelProps) {
  const { t } = useTranslation();
  const [segment, setSegment] = useState<GitPanelSegment>("changes");
  const id = peerTargetId(props.target);
  const { gitError, gitStatus, gitViewMode } = usePeerWorkspaceStore(
    (state) => state.views[id] ?? EMPTY_PEER_VIEW,
  );
  const setGitViewMode = usePeerWorkspaceStore((state) => state.setGitViewMode);
  const viewMode = gitViewMode ?? DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode;
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<GitExpandedTreeNodes>(
    DEFAULT_GIT_EXPANDED_TREE_NODES,
  );
  const hasAnyExpanded = Object.values(expandedTreeNodes).some((nodes) => nodes.length > 0);
  const upgrade = props.updateNeeded || gitError === "unsupported";
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("files:git.panel.header.title")}
    >
      <GitHeaderBar
        disabled={!props.canRead || upgrade}
        hasChanges={(gitStatus?.files.length ?? 0) > 0}
        showViewToggle
        viewMode={viewMode}
        onViewModeChange={(next) => setGitViewMode(id, next)}
        hasAnyExpanded={hasAnyExpanded}
        onToggleAllTrees={() =>
          setExpandedTreeNodes(
            hasAnyExpanded || !gitStatus
              ? DEFAULT_GIT_EXPANDED_TREE_NODES
              : allPeerGitTrees(peerGitEntries(gitStatus.files).entries),
          )
        }
        onRefresh={props.refresh}
      >
        <span title={t("peerWorkspace.gitNoStageCommit")} className="ml-1 inline-flex">
          <PeerReadOnlyBadge compact />
        </span>
      </GitHeaderBar>
      <HistorySegmentToggle segment={segment} onChange={setSegment} />
      <KeptMounted shown={segment === "changes"}>
        <PeerGitChanges
          target={props.target}
          canRead={props.canRead}
          updateNeeded={props.updateNeeded}
          viewMode={viewMode}
          expandedTreeNodes={expandedTreeNodes}
          setExpandedTreeNodes={setExpandedTreeNodes}
        />
      </KeptMounted>
      <KeptMounted shown={segment === "history"}>
        <PeerGitHistory
          target={props.target}
          canRead={props.canRead && segment === "history"}
          updateNeeded={props.updateNeeded}
          rejoin={rejoin}
        />
      </KeptMounted>
    </section>
  );
}

function PeerGitChanges({
  target,
  canRead,
  updateNeeded,
  viewMode,
  expandedTreeNodes,
  setExpandedTreeNodes,
}: Omit<PeerGitPanelProps, "rejoin" | "refresh"> & PeerGitTrees) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const { gitStatus, gitError, tabs } = usePeerWorkspaceStore(
    (state) => state.views[id] ?? EMPTY_PEER_VIEW,
  );
  const openDiff = usePeerWorkspaceStore((state) => state.openDiff);
  const openFile = usePeerWorkspaceStore((state) => state.openFile);
  const upgrade = updateNeeded || gitError === "unsupported";
  const error = upgrade
    ? t("peerWorkspace.updateNeeded")
    : gitError === "not-found"
      ? t("peerWorkspace.gitNotRepository")
      : gitError === "permission-denied"
        ? t("peerWorkspace.accessDenied")
        : gitError
          ? t("peerWorkspace.connectionUnavailable")
          : null;
  const [folded, setFolded] = useState<ReadonlySet<PeerGitGroupKey>>(() => new Set());
  const [menu, setMenu] = useState<PeerGitMenu | null>(null);
  const groups = useMemo(() => (gitStatus ? peerGitEntries(gitStatus.files) : null), [gitStatus]);
  const workspaceRoot = target.workspace.path;
  const topLevel = gitStatus?.topLevel;
  const actions = useMemo<GitGroupActions>(() => {
    const fileOf = (entry: GitStatusEntry) => groups?.files.get(entry.relPath);
    const absolute = (entry: GitStatusEntry) =>
      peerGitPaths(workspaceRoot, topLevel).toWorkspace(entry.relPath)?.absolute ?? null;
    const diff = (entry: GitStatusEntry, groupKey: GitExpandedGroupKey) => {
      const file = fileOf(entry);
      const side = PEER_GIT_SIDE[groupKey];
      if (!file) return;
      const existing = tabs.some(
        (tab) => tab.type === "peer.diff" && tab.path === file.path && tab.side === side,
      );
      if (canRead || existing) openDiff(id, file, side);
    };
    return {
      readOnly: true,
      stage: noop,
      unstage: noop,
      discard: noop,
      markResolved: noop,
      addToGitignore: noop,
      addPathsToGitignore: noop,
      stashGroup: noop,
      revealInOS: noop,
      openDiff: diff,
      openFile: (entry) => {
        const path = absolute(entry);
        if (path && canRead) openFile(id, path);
      },
      copyPath: (entry) => {
        const path = absolute(entry);
        if (path) copyText(path);
      },
      copyRelativePath: (entry) => copyText(entry.relPath),
      openMenu: (entry, groupKey, point) => setMenu({ entry, groupKey, point }),
      toggleGroup: (key) =>
        setFolded((before) => {
          const next = new Set(before);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
      toggleTreeNode: (key, relPath) =>
        setExpandedTreeNodes((before) => {
          const nodes = before[key];
          return {
            ...before,
            [key]: nodes.includes(relPath)
              ? nodes.filter((each) => each !== relPath)
              : [...nodes, relPath],
          };
        }),
    };
  }, [
    groups,
    workspaceRoot,
    topLevel,
    tabs,
    canRead,
    id,
    openDiff,
    openFile,
    setExpandedTreeNodes,
  ]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!gitStatus || !groups || upgrade ? (
        <EmptyState
          title={error ?? t(canRead ? "editor.loading" : "peerWorkspace.connectionUnavailable")}
          tone="status"
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
          <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1 text-app-ui-sm">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate" title={gitStatus.branch ?? undefined}>
              {gitStatus.branch ?? t("peerWorkspace.gitDetached")}
            </span>
            {gitStatus.upstream && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate text-muted-foreground" title={gitStatus.upstream}>
                  {gitStatus.upstream}
                </span>
              </>
            )}
            <span
              className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground"
              role="img"
              aria-label={t("peerWorkspace.gitDivergence", {
                ahead: gitStatus.ahead,
                behind: gitStatus.behind,
              })}
            >
              ↑{gitStatus.ahead} ↓{gitStatus.behind}
            </span>
          </div>
          {(error || gitStatus.truncated) && (
            <div role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
              {error && <div>{error}</div>}
              {gitStatus.truncated && <div>{t("peerWorkspace.gitTruncated")}</div>}
            </div>
          )}
          {gitStatus.files.length === 0 && !gitStatus.truncated && (
            <EmptyState title={t("files:git.panel.noChanges.title")} tone="status" />
          )}
          <div className="py-1">
            {PEER_GIT_GROUPS.map(({ key }) => (
              <GitGroup
                key={key}
                groupKey={key}
                label={t(`files:git.statusGroups.${key}`)}
                entries={groups.entries[key]}
                expanded={!folded.has(key)}
                viewMode={viewMode}
                expandedTreeNodes={expandedTreeNodes[key]}
                actions={actions}
              />
            ))}
          </div>
        </div>
      )}
      <GitFileContextMenu
        point={menu?.point ?? null}
        groupKey={menu?.groupKey ?? "working"}
        actions={menu ? gitFileMenuActions(menu.entry, menu.groupKey, actions) : CLOSED_MENU}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

interface PeerGitTrees {
  viewMode: ViewMode;
  expandedTreeNodes: GitExpandedTreeNodes;
  setExpandedTreeNodes: Dispatch<SetStateAction<GitExpandedTreeNodes>>;
}

interface PeerGitMenu {
  entry: GitStatusEntry;
  groupKey: GitExpandedGroupKey;
  point: GitContextMenuPoint;
}

const PEER_GIT_SIDE = Object.fromEntries(
  PEER_GIT_GROUPS.map(({ key, side }) => [key, side]),
) as Record<PeerGitGroupKey, PeerGitSide>;

export function peerGitEntries(files: readonly PeerGitFile[]): {
  entries: Record<PeerGitGroupKey, GitStatusEntry[]>;
  files: ReadonlyMap<string, PeerGitFile>;
} {
  const grouped = peerGitGroups(files);
  const entry = (file: PeerGitFile): GitStatusEntry => ({
    relPath: file.path,
    ...(file.oldPath ? { oldRelPath: file.oldPath } : {}),
    xy: `${file.staged ?? "."}${file.unstaged ?? "."}`,
    conflictType: null,
  });
  return {
    entries: {
      merge: grouped.merge.map(entry),
      staged: grouped.staged.map(entry),
      working: grouped.working.map(entry),
      untracked: grouped.untracked.map(entry),
    },
    files: new Map(files.map((file) => [file.path, file])),
  };
}

export function allPeerGitTrees(
  entries: Record<PeerGitGroupKey, GitStatusEntry[]>,
): GitExpandedTreeNodes {
  return {
    merge: dirsFromEntries(entries.merge),
    staged: dirsFromEntries(entries.staged),
    working: dirsFromEntries(entries.working),
    untracked: dirsFromEntries(entries.untracked),
  };
}

function noop(): void {}

const CLOSED_MENU: GitFileContextMenuActions = {
  openFile: noop,
  openChanges: noop,
  copyPath: noop,
  copyRelativePath: noop,
};
