import { memo, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppErrorSchema, appErrorFailed } from "../../../shared/error/app-error";
import { useIpcAction } from "../../hooks/use-ipc-action";
import { surfaceError } from "../../services/error-surface/surface-error";
import { openDiffTab } from "../../state/operations";
import { connectWorkspace } from "../../state/operations/workspace-selection";
import { useActiveStore } from "../../state/stores/active";
import { useGitStore } from "../../state/stores/git";
import { usePeerWorkspaceStore } from "../../state/stores/peer-workspace";
import {
  FILES_PANEL_MODE_DEFAULT,
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  useUIStore,
} from "../../state/stores/ui";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { AgentsPanel } from "../agent-list/agents-panel";
import { EMPTY_TREE } from "../editor/diff-refs";
import { NotesPanel } from "../notes/notes-panel";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { ResizeHandle } from "../ui/resize-handle";
import { FileTree } from "./file-tree";
import { GitPanel, type GitPanelOpenDiffInput } from "./git";
import { FilesPanelModeBar } from "./mode-bar";
import { SearchPanel } from "./search/panel";

export const FilesPanel = memo(function FilesPanel({ peerPanel }: { peerPanel?: ReactNode }) {
  const { t } = useTranslation("files");
  const filesPanelWidth = useUIStore((s) => s.filesPanelWidth);
  const setFilesPanelMode = useUIStore((s) => s.setFilesPanelMode);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;
  const filesPanelMode = useUIStore(
    (s) =>
      (activeWorkspace ? s.filesPanelModes.get(activeWorkspace.id) : undefined) ??
      FILES_PANEL_MODE_DEFAULT,
  );
  const workspaceOnline = useWorkspacesStore((s) =>
    activeWorkspace ? selectIsWorkspaceOnline(s, activeWorkspace.id) : true,
  );

  const showOffline =
    activeWorkspace !== null && activeWorkspace.location.kind !== "local" && !workspaceOnline;

  const reconnect = useIpcAction<void>();
  const isReconnecting = reconnect.state.status === "loading";
  const connectionError = reconnect.state.status === "error" ? reconnect.state.error : null;
  useEffect(() => {
    if (connectionError && !usePeerWorkspaceStore.getState().active) {
      surfaceError(connectionError, { surface: "toast" });
    }
  }, [connectionError]);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);

  const handleReconnect = (): void => {
    if (!activeWorkspace || isReconnecting) return;
    void reconnect.run(async (signal) => {
      const result = await connectWorkspace(activeWorkspace.id, signal);
      if (result.ok) return;
      const error = AppErrorSchema.safeParse(result);
      throw error.success ? error.data : appErrorFailed(result.message);
    });
  };

  return (
    <aside className="relative shrink-0 flex flex-col" style={{ width: filesPanelWidth }}>
      <div className="flex flex-col flex-1 min-h-0 island-surface rounded-(--radius-island) overflow-hidden">
        {activeWorkspace ? (
          <>
            <FilesPanelModeBar
              active={filesPanelMode}
              onSelect={(mode) => {
                setFilesPanelMode(activeWorkspace.id, mode);
                if (mode === "search") setSearchFocusRequest((n) => n + 1);
              }}
            />
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {filesPanelMode === "notes" ? (
                <ErrorBoundary logSource="notes-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <NotesPanel key={activeWorkspace.id} workspace={activeWorkspace} />
                  </div>
                </ErrorBoundary>
              ) : showOffline ? (
                <EmptyState
                  title={t("panel.offline.title")}
                  description={t("panel.offline.description")}
                  tone="status"
                  actionLabel={
                    isReconnecting ? t("panel.offline.reconnecting") : t("panel.offline.reconnect")
                  }
                  onAction={handleReconnect}
                  disabled={isReconnecting}
                />
              ) : filesPanelMode === "tree" ? (
                <ErrorBoundary logSource="file-tree-panel">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <FileTree
                      workspaceId={activeWorkspace.id}
                      rootAbsPath={activeWorkspace.rootPath}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "search" ? (
                <ErrorBoundary logSource="search-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <SearchPanel
                      key={activeWorkspace.id}
                      workspaceId={activeWorkspace.id}
                      focusRequest={searchFocusRequest}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "git" ? (
                <ErrorBoundary logSource="git-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <GitPanel
                      workspaceId={activeWorkspace.id}
                      workspaceRootPath={activeWorkspace.rootPath}
                      onOpenDiff={openGitDiffFromRow}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "agents" ? (
                <ErrorBoundary logSource="agent-list-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <AgentsPanel key={activeWorkspace.id} workspace={activeWorkspace} />
                  </div>
                </ErrorBoundary>
              ) : (
                <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
              )}
            </div>
          </>
        ) : peerPanel ? (
          peerPanel
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="whitespace-pre-line px-4 text-center text-app-ui-sm text-muted-foreground">
              {t("panel.noWorkspace")}
            </div>
          </div>
        )}
      </div>
      <ResizeHandle
        value={filesPanelWidth}
        min={FILES_PANEL_WIDTH_MIN}
        max={FILES_PANEL_WIDTH_MAX}
        ariaLabel={t("panel.resize")}
        onResize={(width, persist) => useUIStore.getState().setFilesPanelWidth(width, persist)}
        onReset={() => useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true)}
      />
    </aside>
  );
});

function openGitDiffFromRow({
  workspaceId,
  groupKey,
  entry,
  preview,
}: GitPanelOpenDiffInput): void {
  const isUnborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  const refs = refsForGitGroup(groupKey, isUnborn);
  openDiffTab(workspaceId, entry.relPath, refs.leftRef, refs.rightRef, entry.oldRelPath, {
    ...(preview === false ? { preview: false } : {}),
  });
}

export function refsForGitGroup(
  groupKey: GitPanelOpenDiffInput["groupKey"],
  isUnborn: boolean,
): {
  leftRef: string;
  rightRef: string;
} {
  if (groupKey === "staged") return { leftRef: isUnborn ? EMPTY_TREE : "HEAD", rightRef: "INDEX" };
  if (groupKey === "working") return { leftRef: "INDEX", rightRef: "WORKING" };
  return { leftRef: isUnborn ? EMPTY_TREE : "HEAD", rightRef: "WORKING" };
}
