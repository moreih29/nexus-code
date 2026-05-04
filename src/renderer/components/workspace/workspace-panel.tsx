import { useEffect } from "react";
import { openTerminal } from "@/services/terminal";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";
import { ContentPool, LayoutTree } from ".";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspacePanelProps {
  workspace: WorkspaceMeta;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Component — owns one workspace's layout; mounted once and kept alive
// (via CSS hide) so PTYs survive across workspace switches.
// ---------------------------------------------------------------------------

export function WorkspacePanel({ workspace, isActive }: WorkspacePanelProps) {
  const layout = useLayoutStore((s) => s.byWorkspace[workspace.id]);

  // Auto-seed: ensure layout exists and seed a terminal the first time this
  // panel mounts with an empty tab slice. Guards against double-seeding by
  // checking both tabs and layout state.
  useEffect(() => {
    const layoutStore = useLayoutStore.getState();
    layoutStore.ensureLayout(workspace.id);

    const tabsForWs = useTabsStore.getState().byWorkspace[workspace.id];
    const hasNoTabs = !tabsForWs || Object.keys(tabsForWs).length === 0;

    if (hasNoTabs) {
      openTerminal({ workspaceId: workspace.id, cwd: workspace.rootPath });
    }
    // Run only once on mount per workspace id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workspace.rootPath]);

  if (!layout) return null;

  return (
    <div
      className={cn(
        "col-start-1 row-start-1 flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden relative",
        isActive ? "visible pointer-events-auto" : "invisible pointer-events-none",
      )}
      aria-hidden={!isActive || undefined}
      inert={!isActive || undefined}
    >
      <LayoutTree
        workspaceId={workspace.id}
        root={layout.root}
        onActivateGroup={(gid) => useLayoutStore.getState().setActiveGroup(workspace.id, gid)}
        workspaceRootPath={workspace.rootPath}
      />
      <ContentPool workspaceId={workspace.id} isWorkspaceActive={isActive} />
    </div>
  );
}
