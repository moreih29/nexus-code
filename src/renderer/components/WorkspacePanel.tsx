import { useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import { useTabsStore, useWorkspaceTabs } from "../store/tabs";
import { TabBar } from "./TabBar";
import { TabContent } from "./TabContent";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspacePanelProps {
  workspace: WorkspaceMeta;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Component — owns one workspace's tab slice; mounted once and kept alive
// (via CSS hide) so PTYs survive across workspace switches.
// ---------------------------------------------------------------------------

export function WorkspacePanel({ workspace, isActive }: WorkspacePanelProps) {
  const { tabs, activeTabId } = useWorkspaceTabs(workspace.id);

  const addTab = useTabsStore((s) => s.addTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);

  // Auto-seed a terminal the first time this panel mounts with an empty slice.
  // Replaces the previous boot-effect / handleAddWorkspace seeding paths.
  useEffect(() => {
    if (useTabsStore.getState().byWorkspace[workspace.id]?.tabs.length) return;
    addTab(workspace.id, "terminal", { cwd: workspace.rootPath });
  }, [workspace.id, workspace.rootPath, addTab]);

  const handleSelectTab = useCallback(
    (id: string) => setActiveTab(workspace.id, id),
    [setActiveTab, workspace.id],
  );

  const handleCloseTab = useCallback(
    (id: string) => closeTab(workspace.id, id),
    [closeTab, workspace.id],
  );

  const handleNewTerminalTab = useCallback(() => {
    addTab(workspace.id, "terminal", { cwd: workspace.rootPath });
  }, [addTab, workspace.id, workspace.rootPath]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div
      className={cn(
        "col-start-1 row-start-1 flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden",
        isActive ? "visible pointer-events-auto" : "invisible pointer-events-none",
      )}
      aria-hidden={!isActive || undefined}
      inert={!isActive || undefined}
    >
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTerminalTab={handleNewTerminalTab}
      />
      <TabContent tab={activeTab} />
    </div>
  );
}
