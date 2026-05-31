import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openTerminal } from "@/services/terminal";
import { cn } from "@/utils/cn";
import { createLogger } from "../../../shared/log/renderer";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { useLayoutStore } from "../../state/stores/layout";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { useTerminalDeathStore } from "../../state/stores/terminal-deaths";
import {
  selectIsWorkspaceOnline,
  selectWorkspaceConnectionStatus,
  useWorkspacesStore,
} from "../../state/stores/workspaces";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { StatusBar } from "../workbench/status-bar";
import { ContentPool } from "./content/pool";
import { LayoutTree } from "./layout/tree";
import {
  deadTerminalTabs,
  requestReopenForDeadTerminalTabs,
  shouldShowWorkspaceTerminalStatusBanner,
  WorkspaceTerminalStatusBanner,
} from "./terminal-status-banner";

const log = createLogger("workspace-panel");

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspacePanelProps {
  workspace: WorkspaceMeta;
  isActive: boolean;
}

// Stable empty fallback — returning a fresh `{}` from the selector would change
// identity on every render and trip useSyncExternalStore's infinite-loop guard.
const EMPTY_TABS: Record<string, Tab> = {};

// ---------------------------------------------------------------------------
// Component — owns one workspace's layout; mounted once and kept alive
// (via CSS hide) so PTYs survive across workspace switches.
// ---------------------------------------------------------------------------

export function WorkspacePanel({ workspace, isActive }: WorkspacePanelProps) {
  const { t } = useTranslation();
  const layout = useLayoutStore((s) => s.byWorkspace[workspace.id]);
  const tabs = useTabsStore((s) => s.byWorkspace[workspace.id] ?? EMPTY_TABS);
  const aggregate = useTerminalDeathStore((s) => s.aggregateByWorkspaceId[workspace.id] ?? null);
  const workspaceOnline = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspace.id));
  const connectionStatus = useWorkspacesStore((s) =>
    selectWorkspaceConnectionStatus(s, workspace.id),
  );
  const deadTerminalCount = deadTerminalTabs(tabs).length;
  const showTerminalStatusBanner = shouldShowWorkspaceTerminalStatusBanner({
    aggregate,
    deadTerminalCount,
    workspaceOnline,
  });

  // Whether this workspace needs an offline placeholder instead of the normal panel.
  // Only SSH workspaces that have not yet connected show the placeholder.
  const isSshWorkspace = workspace.location.kind === "ssh";
  const showOfflinePlaceholder = isSshWorkspace && !workspaceOnline;

  // Auto-seed: ensure layout exists and seed a terminal the first time this
  // panel mounts with an empty tab slice. Only runs when the workspace is
  // online (connected) — skipped for disconnected SSH workspaces to avoid
  // triggering a password prompt before the user explicitly connects.
  useEffect(() => {
    if (showOfflinePlaceholder) return;

    const layoutStore = useLayoutStore.getState();
    layoutStore.ensureLayout(workspace.id);

    const tabsForWs = useTabsStore.getState().byWorkspace[workspace.id];
    const hasNoTabs = !tabsForWs || Object.keys(tabsForWs).length === 0;

    if (hasNoTabs) {
      openTerminal({ workspaceId: workspace.id, cwd: workspace.rootPath });
    }
    // Re-run when the workspace comes online after starting disconnected so
    // the terminal seeds once connection is established.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workspace.rootPath, showOfflinePlaceholder]);

  function handleConnect() {
    void ipcCallResult("workspace", "activate", { id: workspace.id }).then((result) => {
      if (!result.ok) log.warn(`activate failed: ${result.message}`);
    });
  }

  if (showOfflinePlaceholder) {
    const isError = connectionStatus === "error";
    const sshLabel =
      workspace.location.kind === "ssh"
        ? `${workspace.location.user ? `${workspace.location.user}@` : ""}${workspace.location.host}`
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
        <div className="flex flex-1 items-center justify-center island-surface rounded-(--radius-island) overflow-hidden">
          <EmptyState
            title={isError ? t("panel.connection_failed") : workspace.name}
            description={
              isError
                ? t("panel.could_not_connect", { label: sshLabel })
                : sshLabel
                  ? t("panel.ssh_workspace", { label: sshLabel })
                  : undefined
            }
            actionLabel={isError ? t("action.retry") : t("action.connect")}
            onAction={handleConnect}
            tone="status"
          />
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
      {/* ErrorBoundary: a render crash in one workspace panel is isolated so
          other mounted workspace panels (including any active one) survive.
          The logSource includes the workspace id for tracing in the log file. */}
      <ErrorBoundary logSource={`workspace-panel:${workspace.id}`}>
        {showTerminalStatusBanner && (
          <WorkspaceTerminalStatusBanner
            deadTerminalCount={deadTerminalCount}
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
          onActivateGroup={(gid) => useLayoutStore.getState().setActiveGroup(workspace.id, gid)}
          workspaceRootPath={workspace.rootPath}
        />
        <ContentPool workspaceId={workspace.id} isWorkspaceActive={isActive} />
        <StatusBar workspaceId={workspace.id} />
      </ErrorBoundary>
    </div>
  );
}
