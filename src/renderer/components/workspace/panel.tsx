import { memo, useCallback, useEffect } from "react";
import { openTerminal } from "@/services/terminal";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { bannerEventId, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useLayoutStore } from "../../state/stores/layout";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { useTerminalDeathStore } from "../../state/stores/terminal-deaths";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { ErrorBoundary } from "../ui/error-boundary";
import { StatusBar } from "../workbench/status-bar";
import { ContentPool } from "./content/pool";
import { LayoutTree } from "./layout/tree";
import { OfflineWorkspace } from "./offline-workspace";
import {
  deadTerminalTabs,
  requestReopenForDeadTerminalTabs,
  shouldShowWorkspaceTerminalStatusBanner,
  WorkspaceTerminalStatusBanner,
} from "./terminal-status-banner";

interface WorkspacePanelProps {
  workspace: WorkspaceMeta;
  isActive: boolean;
}

const EMPTY_TABS: Record<string, Tab> = {};

export const WorkspacePanel = memo(function WorkspacePanel({
  workspace,
  isActive,
}: WorkspacePanelProps) {
  const layout = useLayoutStore((s) => s.byWorkspace[workspace.id]);
  const tabs = useTabsStore((s) => s.byWorkspace[workspace.id] ?? EMPTY_TABS);
  const aggregate = useTerminalDeathStore((s) => s.aggregateByWorkspaceId[workspace.id] ?? null);
  const workspaceOnline = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspace.id));
  const deadTerminalCount = deadTerminalTabs(tabs).length;
  const showTerminalStatusBanner = shouldShowWorkspaceTerminalStatusBanner({
    aggregate,
    deadTerminalCount,
    workspaceOnline,
  });

  const terminalNotice = useBannerDismissal(
    ["workspace-terminal-status", workspace.id],
    aggregate ? [bannerEventId(aggregate), deadTerminalCount] : undefined,
  );

  const isRemoteWorkspace = workspace.location.kind !== "local";
  const showOfflinePlaceholder = isRemoteWorkspace && !workspaceOnline;

  useEffect(() => {
    if (showOfflinePlaceholder) return;

    const layoutStore = useLayoutStore.getState();
    layoutStore.ensureLayout(workspace.id);

    const tabsForWs = useTabsStore.getState().byWorkspace[workspace.id];
    const hasNoTabs = !tabsForWs || Object.keys(tabsForWs).length === 0;

    if (hasNoTabs) {
      openTerminal({ workspaceId: workspace.id, cwd: workspace.rootPath });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workspace.rootPath, showOfflinePlaceholder]);

  const handleActivateGroup = useCallback(
    (groupId: string) => useLayoutStore.getState().setActiveGroup(workspace.id, groupId),
    [workspace.id],
  );

  if (showOfflinePlaceholder) {
    return (
      <div
        className={cn(
          "col-start-1 row-start-1 flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden relative",
          isActive ? "visible pointer-events-auto" : "invisible pointer-events-none",
        )}
        aria-hidden={!isActive || undefined}
        inert={!isActive || undefined}
      >
        <div className="relative flex flex-1 items-center justify-center island-surface rounded-(--radius-island) overflow-hidden">
          <OfflineWorkspace workspaceId={workspace.id} />
        </div>
      </div>
    );
  }

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
      <ErrorBoundary logSource={`workspace-panel:${workspace.id}`}>
        {showTerminalStatusBanner && !terminalNotice.dismissed && (
          <WorkspaceTerminalStatusBanner
            deadTerminalCount={deadTerminalCount}
            dismiss={terminalNotice.dismiss}
            onReopenAll={() => {
              requestReopenForDeadTerminalTabs(
                workspace.id,
                useTabsStore.getState().byWorkspace[workspace.id] ?? {},
              );
            }}
          />
        )}
        <LayoutTree
          workspaceId={workspace.id}
          root={layout.root}
          onActivateGroup={handleActivateGroup}
          workspaceRootPath={workspace.rootPath}
        />
        <ContentPool workspaceId={workspace.id} isWorkspaceActive={isActive} />
        <StatusBar workspaceId={workspace.id} />
      </ErrorBoundary>
    </div>
  );
});
