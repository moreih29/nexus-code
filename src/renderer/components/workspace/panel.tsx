import { memo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openTerminal } from "@/services/terminal";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { bannerEventId, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { retryWorkspaceConnection } from "../../state/operations/workspace-selection";
import { useLayoutStore } from "../../state/stores/layout";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { useTerminalDeathStore } from "../../state/stores/terminal-deaths";
import {
  selectIsWorkspaceOnline,
  selectWorkspaceConnectionProgress,
  selectWorkspaceConnectionStatus,
  useWorkspacesStore,
} from "../../state/stores/workspaces";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { StatusBar } from "../workbench/status-bar";
import { BootstrapProgressBar } from "./bootstrap-progress-bar";
import { ContentPool } from "./content/pool";
import { LayoutTree } from "./layout/tree";
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
  const { t } = useTranslation();
  const layout = useLayoutStore((s) => s.byWorkspace[workspace.id]);
  const tabs = useTabsStore((s) => s.byWorkspace[workspace.id] ?? EMPTY_TABS);
  const aggregate = useTerminalDeathStore((s) => s.aggregateByWorkspaceId[workspace.id] ?? null);
  const workspaceOnline = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspace.id));
  const connectionStatus = useWorkspacesStore((s) =>
    selectWorkspaceConnectionStatus(s, workspace.id),
  );
  const connectionProgress = useWorkspacesStore((s) =>
    selectWorkspaceConnectionProgress(s, workspace.id),
  );
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
  const isSessionExpired = connectionStatus === "held-then-expired";

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

  function handleConnect(): void {
    retryWorkspaceConnection(workspace.id);
  }

  if (showOfflinePlaceholder) {
    const isError = connectionStatus === "error";
    const isConnecting = connectionStatus === "connecting" || connectionStatus === "reconnecting";
    const isWsl = workspace.location.kind === "wsl";
    const sshLabel =
      workspace.location.kind === "ssh"
        ? `${workspace.location.user ? `${workspace.location.user}@` : ""}${workspace.location.host}`
        : workspace.location.kind === "wsl"
          ? workspace.location.distro
          : "";
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
          {isSessionExpired ? (
            <EmptyState
              title={t("panel.session_expired")}
              description={t("panel.session_expired_desc")}
              actionLabel={t("action.connect")}
              onAction={handleConnect}
              tone="status"
            />
          ) : (
            <EmptyState
              title={isError ? t("panel.connection_failed") : workspace.name}
              description={
                isError
                  ? t(isWsl ? "panel.could_not_start_wsl" : "panel.could_not_connect", {
                      label: sshLabel,
                    })
                  : sshLabel
                    ? t(isWsl ? "panel.wsl_workspace" : "panel.ssh_workspace", { label: sshLabel })
                    : undefined
              }
              actionLabel={isError ? t("action.retry") : t("action.connect")}
              onAction={handleConnect}
              tone="status"
            />
          )}
          {isConnecting && connectionProgress && (
            <BootstrapProgressBar
              phase={connectionProgress.phase}
              name={connectionProgress.name}
              bytesDone={connectionProgress.bytesDone}
              bytesTotal={connectionProgress.bytesTotal}
              className="absolute bottom-0 left-0 right-0 px-5 pb-4"
            />
          )}
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
