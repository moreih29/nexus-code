import { Folder, GitBranch, Search } from "lucide-react";
import { cn } from "@/utils/cn";
import { EMPTY_TREE } from "../editor/diff-refs";
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
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Button } from "../ui/button";
import { ResizeHandle } from "../ui/resize-handle";
import { FileTree } from "./file-tree";
import { GitPanel, type GitPanelOpenDiffInput } from "./git";
import { SearchPanel } from "./search";

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

  return (
    <aside
      className="relative shrink-0 bg-muted border-r border-r-mist-border flex flex-col"
      style={{ width: filesPanelWidth }}
    >
      {activeWorkspace ? (
        <>
          <div className="flex items-center gap-1 px-2 pt-2 pb-1.5 border-b border-mist-border/50">
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
                  className={cn(isActive && "bg-frosted-veil-strong text-foreground")}
                  onClick={() => setFilesPanelMode(activeWorkspace.id, mode)}
                >
                  <Icon />
                </Button>
              );
            })}
          </div>
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            {filesPanelMode === "tree" ? (
              <div className="flex-1 min-h-0 overflow-hidden">
                <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
              </div>
            ) : filesPanelMode === "search" ? (
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                <SearchPanel workspaceId={activeWorkspace.id} />
              </div>
            ) : filesPanelMode === "git" ? (
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                <GitPanel
                  workspaceId={activeWorkspace.id}
                  workspaceRootPath={activeWorkspace.rootPath}
                  onOpenDiff={openGitDiffFromRow}
                />
              </div>
            ) : (
              <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
            )}
          </div>
        </>
      ) : (
        <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
          Select a workspace
          <br />
          to browse files.
        </div>
      )}
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
