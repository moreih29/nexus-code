import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openTerminal } from "@/services/terminal";
import { cn } from "@/utils/cn";
import { createLogger } from "../../../shared/log/renderer";
import type {
  WorkspaceConnectionProgressEvent,
  WorkspaceMeta,
} from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
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
  const connectionProgress = useWorkspacesStore((s) =>
    selectWorkspaceConnectionProgress(s, workspace.id),
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
    const isConnecting = connectionStatus === "connecting" || connectionStatus === "reconnecting";
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
        <div className="relative flex flex-1 items-center justify-center island-surface rounded-(--radius-island) overflow-hidden">
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
          {isConnecting && connectionProgress && (
            <BootstrapProgressBar progress={connectionProgress} />
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

// ---------------------------------------------------------------------------
// 부트스트랩 진행 표시줄
// ---------------------------------------------------------------------------

/**
 * diff-tab.tsx의 formatBytes와 동일한 구현. 별도 공유 유틸이 없으므로 인라인 복사.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

/**
 * SSH 에이전트 부트스트랩 진행 표시줄.
 *
 * 정직한 진행률 표시 규칙:
 * - bytesTotal>0 이고 0<bytesDone<bytesTotal 인 경우에만 determinate 바 렌더.
 * - 나머지 모든 경우는 indeterminate(animated) 바 렌더.
 *
 * 플레이스홀더 컨테이너 하단에 절대 위치로 붙인다.
 */
function BootstrapProgressBar({ progress }: { progress: WorkspaceConnectionProgressEvent }) {
  const { t } = useTranslation();

  const { phase, name, bytesDone, bytesTotal } = progress;

  // phase 레이블: 이름이 필요한 phase("uploading", "extracting")에는 name을 보간한다.
  const phaseLabel = t(`panel.bootstrap_phase.${phase}`, { name });

  // 사이즈 문자열: bytesTotal이 있을 때만 표시한다.
  const sizeLabel = bytesTotal && bytesTotal > 0 ? formatBytes(bytesTotal) : undefined;

  // Determinate 여부: bytesDone이 존재하고 0<bytesDone<bytesTotal인 경우에만.
  const isDeterminate =
    bytesTotal !== undefined &&
    bytesTotal > 0 &&
    bytesDone !== undefined &&
    bytesDone > 0 &&
    bytesDone < bytesTotal;
  const percent = isDeterminate ? Math.round((bytesDone / bytesTotal) * 100) : undefined;

  return (
    <div className="absolute bottom-0 left-0 right-0 flex flex-col gap-1 px-5 pb-4">
      <div className="flex items-baseline justify-between gap-2 text-app-micro text-muted-foreground">
        <span className="truncate">{phaseLabel}</span>
        {sizeLabel && <span className="shrink-0 tabular-nums">{sizeLabel}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={phaseLabel}
        aria-valuenow={percent}
        aria-valuemin={isDeterminate ? 0 : undefined}
        aria-valuemax={isDeterminate ? 100 : undefined}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        {isDeterminate ? (
          <div
            className="h-full rounded-full bg-muted-foreground/50 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        ) : (
          // indeterminate: pulse 애니메이션으로 진행 중임을 표시
          <div className="h-full w-full rounded-full bg-muted-foreground/50 motion-safe:animate-pulse" />
        )}
      </div>
    </div>
  );
}
