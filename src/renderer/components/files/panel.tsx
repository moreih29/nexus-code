import { Folder, GitBranch, Search } from "lucide-react";
import { cn } from "@/utils/cn";
import { openDiffTab } from "../../state/operations";
import { useActiveStore } from "../../state/stores/active";
import { useGitStore } from "../../state/stores/git";
import {
  FILES_PANEL_MODE_DEFAULT,
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  type FilesPanelMode,
  useUIStore,
} from "../../state/stores/ui";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { EMPTY_TREE } from "../editor/diff-refs";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { ResizeHandle } from "../ui/resize-handle";
import { FileTree } from "./file-tree";
import { GitPanel, type GitPanelOpenDiffInput } from "./git";
import { SearchPanel } from "./search/panel";

interface ModeButton {
  mode: FilesPanelMode;
  label: string;
  Icon: typeof Folder;
}

const MODE_BUTTONS: ModeButton[] = [
  { mode: "tree", label: "File tree", Icon: Folder },
  { mode: "search", label: "Find in workspace", Icon: Search },
  { mode: "git", label: "Source control", Icon: GitBranch },
];

export function FilesPanel() {
  const filesPanelWidth = useUIStore((s) => s.filesPanelWidth);
  const setFilesPanelMode = useUIStore((s) => s.setFilesPanelMode);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;
  // Per-workspace mode: subscribe by workspace id so switching workspaces
  // pulls a fresh value instead of carrying the previous one over.
  const filesPanelMode = useUIStore(
    (s) =>
      (activeWorkspace ? s.filesPanelModes.get(activeWorkspace.id) : undefined) ??
      FILES_PANEL_MODE_DEFAULT,
  );
  const workspaceOnline = useWorkspacesStore((s) =>
    activeWorkspace ? selectIsWorkspaceOnline(s, activeWorkspace.id) : true,
  );

  // For disconnected SSH workspaces, suppress all remote-reading panels so
  // no IPC call reaches getFs / getAgentChannel before the user connects.
  const showOffline =
    activeWorkspace?.location.kind === "ssh" && !workspaceOnline;

  return (
    <aside className="relative shrink-0 flex flex-col" style={{ width: filesPanelWidth }}>
      <div className="flex flex-col flex-1 min-h-0 island-surface rounded-(--radius-island) overflow-hidden">
        {activeWorkspace ? (
          <>
            <div className="flex items-center gap-1 px-2 pt-2 pb-2 border-b border-border/50">
              {MODE_BUTTONS.map(({ mode, label, Icon }) => {
                const isActive = filesPanelMode === mode;
                return (
                  <Button
                    key={mode}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label}
                    aria-pressed={isActive}
                    title={label}
                    // Persistent mode pick → state.selected.* (not state.active.bg,
                    // which is the transient mouse-down overlay — design.md §8).
                    // aria-pressed supplies the redundant signal channel.
                    className={cn(
                      isActive &&
                        "bg-[var(--state-selected-bg)] text-[var(--state-selected-fg)]",
                    )}
                    onClick={() => setFilesPanelMode(activeWorkspace.id, mode)}
                  >
                    <Icon />
                  </Button>
                );
              })}
            </div>
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {showOffline ? (
                <EmptyState
                  title="Not connected"
                  description="Connect to the workspace to browse files."
                  tone="status"
                />
              ) : filesPanelMode === "tree" ? (
                // ErrorBoundary: a crash in the file tree must not collapse
                // the entire sidebar or prevent switching to other modes.
                <ErrorBoundary logSource="file-tree-panel">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <FileTree
                      workspaceId={activeWorkspace.id}
                      rootAbsPath={activeWorkspace.rootPath}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "search" ? (
                // ErrorBoundary: search panel crash is isolated — git and file
                // tree panels remain functional.
                <ErrorBoundary logSource="search-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <SearchPanel workspaceId={activeWorkspace.id} />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "git" ? (
                // ErrorBoundary: git panel crash is isolated — the editor and
                // terminal panels in the workspace remain unaffected.
                <ErrorBoundary logSource="git-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <GitPanel
                      workspaceId={activeWorkspace.id}
                      workspaceRootPath={activeWorkspace.rootPath}
                      onOpenDiff={openGitDiffFromRow}
                    />
                  </div>
                </ErrorBoundary>
              ) : (
                <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="px-4 text-center text-app-ui-sm text-muted-foreground">
              Select a workspace
              <br />
              to browse files.
            </div>
          </div>
        )}
      </div>
      <ResizeHandle
        value={filesPanelWidth}
        min={FILES_PANEL_WIDTH_MIN}
        max={FILES_PANEL_WIDTH_MAX}
        ariaLabel="Resize files panel"
        onResize={(width, persist) => useUIStore.getState().setFilesPanelWidth(width, persist)}
        onReset={() => useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true)}
      />
    </aside>
  );
}

function openGitDiffFromRow({ workspaceId, groupKey, entry }: GitPanelOpenDiffInput): void {
  const isUnborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  const refs = refsForGitGroup(groupKey, isUnborn);
  openDiffTab(workspaceId, entry.relPath, refs.leftRef, refs.rightRef, entry.oldRelPath);
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
