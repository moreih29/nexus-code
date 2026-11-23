import { useTranslation } from "react-i18next";
import { locationLabel } from "../../../shared/types/workspace";
import { retryWorkspaceConnection } from "../../state/operations/workspace-selection";
import {
  selectIsWorkspaceOnline,
  selectWorkspaceConnectionProgress,
  selectWorkspaceConnectionStatus,
  useWorkspace,
  useWorkspacesStore,
} from "../../state/stores/workspaces";
import { EmptyState } from "../ui/empty-state";
import { BootstrapProgressBar } from "./bootstrap-progress-bar";

export function useWorkspaceOffline(workspaceId: string): boolean {
  const remote = useWorkspace(workspaceId, (w) => w?.location.kind !== "local");
  const online = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspaceId));
  return remote && !online;
}

export function OfflineWorkspace({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace(workspaceId);
  const status = useWorkspacesStore((s) => selectWorkspaceConnectionStatus(s, workspaceId));
  const progress = useWorkspacesStore((s) => selectWorkspaceConnectionProgress(s, workspaceId));
  if (!workspace) return null;
  const connecting = status === "connecting" || status === "reconnecting";
  const connect = () => retryWorkspaceConnection(workspaceId);
  const label = locationLabel(workspace.location) ?? "";
  const wsl = workspace.location.kind === "wsl";
  return (
    <>
      {status === "held-then-expired" ? (
        <EmptyState
          title={t("panel.session_expired")}
          description={t("panel.session_expired_desc")}
          actionLabel={connecting ? t("action.connecting") : t("action.connect")}
          onAction={connect}
          disabled={connecting}
          tone="status"
        />
      ) : status === "error" ? (
        <EmptyState
          title={t("panel.connection_failed")}
          description={t(wsl ? "panel.could_not_start_wsl" : "panel.could_not_connect", { label })}
          actionLabel={t("action.retry")}
          onAction={connect}
          tone="status"
        />
      ) : (
        <EmptyState
          title={workspace.name}
          description={
            label ? t(wsl ? "panel.wsl_workspace" : "panel.ssh_workspace", { label }) : undefined
          }
          actionLabel={connecting ? t("action.connecting") : t("action.connect")}
          onAction={connect}
          disabled={connecting}
          tone="status"
        />
      )}
      {connecting && progress && (
        <BootstrapProgressBar
          phase={progress.phase}
          name={progress.name}
          bytesDone={progress.bytesDone}
          bytesTotal={progress.bytesTotal}
          className="absolute bottom-0 left-0 right-0 px-5 pb-4"
        />
      )}
    </>
  );
}
