/**
 * Language server status → store, and the toasts a status calls for: a
 * server that gave up after failing again and again, and the first time the
 * workspace cap stops a workspace's servers.
 */

import i18next from "i18next";
import { isBuiltinLspPresetLanguageId } from "../../../shared/lsp/config";
import type { LspServerStatus } from "../../../shared/lsp/status";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { clearProgressFor } from "../../services/lsp-ux/server-ux-router";
import { useLspLogViewerStore } from "../stores/lsp-log-viewer";
import { useLspSettingsStore } from "../stores/lsp-settings";
import { lspStatusKey, useLspStatusStore } from "../stores/lsp-status";
import { useWorkspacesStore } from "../stores/workspaces";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

let unlisten: (() => void) | null = null;
let unregisterCleanup: (() => void) | null = null;
/** The cap is explained once a session; the status bar says it after. */
let evictionExplained = false;

/** Safe to call more than once — the previous listener is removed first. */
export function initLspStatusSync(): void {
  unlisten?.();
  unregisterCleanup?.();
  unlisten = ipcListen("lsp", "serverStatus", (status) => {
    const store = useLspStatusStore.getState();
    const previous = store.statuses[lspStatusKey(status.workspaceId, status.languageId)];
    if (status.state !== "running") clearProgressFor(status.workspaceId, status.languageId);
    store.setStatus(status);
    notify(status, previous);
  });
  unregisterCleanup = registerWorkspaceCleanup((workspaceId) =>
    useLspStatusStore.getState().forgetWorkspace(workspaceId),
  );
  void ipcCallResult("lsp", "serverStatuses", undefined).then((result) => {
    if (result.ok) useLspStatusStore.getState().hydrate(result.value);
  });
}

function notify(status: LspServerStatus, previous: LspServerStatus | undefined): void {
  const workspace =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === status.workspaceId)?.name ??
    status.workspaceId;
  const language = i18next.t(`lsp.language.${status.languageId}`, {
    defaultValue: status.languageId,
  });

  if (status.gaveUp && !previous?.gaveUp && isBuiltinLspPresetLanguageId(status.languageId)) {
    const { workspaceId, languageId } = status;
    showToast({
      kind: "error",
      message: i18next.t("lsp.gaveUp", { workspace, language }),
      details: status.error,
      actions: [
        {
          label: i18next.t("lsp.restart"),
          onAction: () => void ipcCallResult("lsp", "restartServer", { workspaceId, languageId }),
        },
        {
          label: i18next.t("lsp.showLog"),
          onAction: () => useLspLogViewerStore.getState().open({ workspaceId, languageId }),
        },
      ],
    });
    return;
  }

  if (
    status.state === "stopped" &&
    status.stopReason === "evicted" &&
    previous?.stopReason !== "evicted" &&
    !evictionExplained
  ) {
    evictionExplained = true;
    showToast({
      kind: "info",
      message: i18next.t("lsp.evicted", {
        workspace,
        count: useLspSettingsStore.getState().settings.maxActiveWorkspaces,
      }),
    });
  }
}
