import { useActiveStore } from "../store/active";
import {
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  useUIStore,
} from "../store/ui";
import { useWorkspacesStore } from "../store/workspaces";
import { FileTree } from "./FileTree";
import { ResizeHandle } from "./ResizeHandle";

export function FilesPanel() {
  const filesPanelWidth = useUIStore((s) => s.filesPanelWidth);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;

  return (
    <aside
      className="relative shrink-0 bg-muted border-r border-r-mist-border flex flex-col"
      style={{ width: filesPanelWidth }}
    >
      {activeWorkspace ? (
        <>
          <div className="px-3 pt-3 pb-2 text-app-ui-xs uppercase tracking-[2.4px] text-stone-gray select-none truncate">
            {activeWorkspace.name}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
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
