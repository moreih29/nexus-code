import { useMemo } from "react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type {
  OpenSessionWorkspace,
  WorkspaceSidebarState,
} from "../../../../../shared/src/contracts/workspace/workspace-shell";
import { workspaceTabId } from "../../components/WorkspaceStrip";
import type {
  ActivityBarSideBarRoute,
  ActivityBarView,
  ActivityBarViewId,
} from "../../services/activity-bar-service";
import type {
  BottomPanelPosition,
  BottomPanelView,
  BottomPanelViewId,
} from "../../services/bottom-panel-service";
import type { CenterWorkbenchMode } from "../../services/editor-types";
import type {
  FilesFileTreeState,
  FilesPendingExplorerDelete,
  FilesPendingExplorerEdit,
} from "../../services/files-service";
import type { TerminalTab } from "../../services/terminal-service";
import type { WorkspaceGitBadgeStatus } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { FileClipboardPendingCollision } from "../../stores/file-clipboard-store";
import type { HarnessWorkspaceBadge } from "../../stores/harnessBadgeStore";
import type { HarnessSessionRef } from "../../stores/harnessSessionStore";
import type { HarnessToolFeedEntry } from "../../stores/harnessToolFeedStore";
import type { AppServices } from "../wiring";

const EMPTY_TOOL_FEED_ENTRIES: readonly HarnessToolFeedEntry[] = [];

export interface AppShellState {
  sidebarState: WorkspaceSidebarState;
  activeWorkspace: OpenSessionWorkspace | null;
  activeWorkspaceTabId: string | undefined;
  activityBarViews: readonly ActivityBarView[];
  activeActivityBarViewId: ActivityBarViewId;
  sideBarCollapsed: boolean;
  activeSideBarRoute: ActivityBarSideBarRoute | null;
  bottomPanelViews: readonly BottomPanelView[];
  activeBottomPanelViewId: BottomPanelViewId | null;
  bottomPanelPosition: BottomPanelPosition;
  bottomPanelExpanded: boolean;
  bottomPanelHeight: number;
  detachedBottomPanelTerminalIds: readonly TerminalTab["id"][];
  badgeByWorkspaceId: Record<string, HarnessWorkspaceBadge>;
  toolFeedByWorkspaceId: Record<string, HarnessToolFeedEntry[]>;
  sessionByWorkspaceId: Record<string, HarnessSessionRef>;
  activeToolFeedEntries: readonly HarnessToolFeedEntry[];
  activeSessionRef: HarnessSessionRef | null;
  editorFileTree: FilesFileTreeState;
  editorExpandedPaths: Record<string, true>;
  editorGitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  editorSelectedTreePath: string | null;
  editorPendingExplorerEdit: FilesPendingExplorerEdit | null;
  editorPendingExplorerDelete: FilesPendingExplorerDelete | null;
  editorCenterMode: CenterWorkbenchMode;
  fileClipboardCanPaste: boolean;
  fileClipboardPendingCollision: FileClipboardPendingCollision | null;
  terminalTabs: readonly TerminalTab[];
}

export function useAppShellState(services: AppServices): AppShellState {
  const sidebarState = useStore(services.workspace, (state) => state.sidebarState);
  const activityBarViews = useStore(services.activityBar, (state) => state.views);
  const activeActivityBarViewId = useStore(services.activityBar, (state) => state.activeViewId);
  const sideBarCollapsed = useStore(services.activityBar, (state) => state.sideBarCollapsed);
  const bottomPanelViews = useStore(services.bottomPanel, (state) => state.views);
  const activeBottomPanelViewId = useStore(services.bottomPanel, (state) => state.activeViewId);
  const bottomPanelPosition = useStore(services.bottomPanel, (state) => state.position);
  const bottomPanelExpanded = useStore(services.bottomPanel, (state) => state.expanded);
  const bottomPanelHeight = useStore(services.bottomPanel, (state) => state.height);
  const detachedBottomPanelTerminalIds = useStore(services.bottomPanel, (state) => state.detachedTerminalIds);
  const badgeByWorkspaceId = useStore(services.harnessBadge, (state) => state.badgeByWorkspaceId);
  const toolFeedByWorkspaceId = useStore(services.harnessToolFeed, (state) => state.feedByWorkspaceId);
  const sessionByWorkspaceId = useStore(services.harnessSession, (state) => state.sessionByWorkspaceId);
  const editorFileTree = useStore(services.files, (state) => state.fileTree);
  const editorExpandedPaths = useStore(services.files, (state) => state.expandedPaths);
  const editorGitBadgeByPath = useStore(services.git, (state) => state.pathBadgeByPath);
  const editorSelectedTreePath = useStore(services.files, (state) => state.selectedPath);
  const editorPendingExplorerEdit = useStore(services.files, (state) => state.pendingExplorerEdit);
  const editorPendingExplorerDelete = useStore(services.files, (state) => state.pendingExplorerDelete);
  const editorCenterMode = useStore(services.editorWorkspace, (state) => state.centerMode);
  const fileClipboardCanPaste = useStore(services.fileClipboard, (state) => state.hasClipboardItems());
  const fileClipboardPendingCollision = useStore(services.fileClipboard, (state) => state.pendingCollision);
  const terminalTabs = useStore(services.terminal, (state) => state.tabs);

  const activeWorkspaceId = sidebarState.activeWorkspaceId;
  const activeWorkspace = useMemo(
    () => resolveActiveWorkspace(sidebarState, activeWorkspaceId),
    [activeWorkspaceId, sidebarState],
  );
  const activeWorkspaceTabId = activeWorkspace ? workspaceTabId(activeWorkspace.id) : undefined;
  const activeSideBarRoute = useMemo(
    () => resolveActiveSideBarRoute(activityBarViews, activeActivityBarViewId),
    [activityBarViews, activeActivityBarViewId],
  );
  const activeToolFeedEntries = useMemo(
    () => activeWorkspaceId
      ? (toolFeedByWorkspaceId[activeWorkspaceId] ?? EMPTY_TOOL_FEED_ENTRIES)
      : EMPTY_TOOL_FEED_ENTRIES,
    [activeWorkspaceId, toolFeedByWorkspaceId],
  );
  const activeSessionRef = activeWorkspaceId
    ? (sessionByWorkspaceId[activeWorkspaceId] ?? null)
    : null;

  return useMemo(() => ({
    sidebarState,
    activeWorkspace,
    activeWorkspaceTabId,
    activityBarViews,
    activeActivityBarViewId,
    sideBarCollapsed,
    activeSideBarRoute,
    bottomPanelViews,
    activeBottomPanelViewId,
    bottomPanelPosition,
    bottomPanelExpanded,
    bottomPanelHeight,
    detachedBottomPanelTerminalIds,
    badgeByWorkspaceId,
    toolFeedByWorkspaceId,
    sessionByWorkspaceId,
    activeToolFeedEntries,
    activeSessionRef,
    editorFileTree,
    editorExpandedPaths,
    editorGitBadgeByPath,
    editorSelectedTreePath,
    editorPendingExplorerEdit,
    editorPendingExplorerDelete,
    editorCenterMode,
    fileClipboardCanPaste,
    fileClipboardPendingCollision,
    terminalTabs,
  }), [
    activeActivityBarViewId,
    activeBottomPanelViewId,
    activeSessionRef,
    activeSideBarRoute,
    activeToolFeedEntries,
    activeWorkspace,
    activeWorkspaceTabId,
    activityBarViews,
    badgeByWorkspaceId,
    bottomPanelExpanded,
    bottomPanelHeight,
    bottomPanelPosition,
    bottomPanelViews,
    detachedBottomPanelTerminalIds,
    editorCenterMode,
    editorExpandedPaths,
    editorFileTree,
    editorGitBadgeByPath,
    editorPendingExplorerDelete,
    editorPendingExplorerEdit,
    editorSelectedTreePath,
    fileClipboardCanPaste,
    fileClipboardPendingCollision,
    sessionByWorkspaceId,
    sideBarCollapsed,
    sidebarState,
    terminalTabs,
    toolFeedByWorkspaceId,
  ]);
}

function resolveActiveWorkspace(
  sidebarState: WorkspaceSidebarState,
  activeWorkspaceId: WorkspaceId | null,
): OpenSessionWorkspace | null {
  return activeWorkspaceId
    ? (sidebarState.openWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null)
    : null;
}

function resolveActiveSideBarRoute(
  views: readonly ActivityBarView[],
  activeViewId: ActivityBarViewId,
): ActivityBarSideBarRoute | null {
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  return activeView
    ? { title: activeView.sideBarTitle, contentId: activeView.sideBarContentId }
    : null;
}
