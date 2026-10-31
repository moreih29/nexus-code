/**
 * Language server status → store, and the toasts a status calls for: a
 * server that is not installed, one that gave up after failing again and
 * again, and the first time the workspace cap stops a workspace's servers.
 */

import i18next from "i18next";
import { isBuiltinLspPresetLanguageId, resolveLspPreset } from "../../../shared/lsp/config";
import type { LspServerStatus } from "../../../shared/lsp/status";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { clearLspDiagnostics } from "../../services/editor/lsp/bridge";
import { clearProgressFor } from "../../services/lsp-ux/server-ux-router";
import { useLspLogViewerStore } from "../stores/lsp-log-viewer";
import { useLspSettingsStore } from "../stores/lsp-settings";
import { lspStatusKey, useLspStatusStore } from "../stores/lsp-status";
import { useSettingsUIStore } from "../stores/settings-ui";
import { useWorkspacesStore } from "../stores/workspaces";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

let unlisten: (() => void) | null = null;
let unregisterCleanup: (() => void) | null = null;
/** The cap is explained once a session; the status bar says it after. */
let evictionExplained = false;
/**
 * Languages whose missing server was reported, so each workspace that
 * opens a file of the language does not report it again. Cleared once the
 * server runs.
 */
const missingReported = new Set<string>();

/** Safe to call more than once — the previous listener is removed first. */
export function initLspStatusSync(): void {
  unlisten?.();
  unregisterCleanup?.();
  unlisten = ipcListen("lsp", "serverStatus", (status) => {
    const store = useLspStatusStore.getState();
    const previous = store.statuses[lspStatusKey(status.workspaceId, status.languageId)];
    if (status.state !== "running") clearProgressFor(status.workspaceId, status.languageId);
    // A server stopped for idling comes back with the next edit; one turned
    // off or given up on does not, and its errors would stay on screen.
    if (status.state === "failed" || (status.state === "stopped" && status.stopReason === "off")) {
      clearLspDiagnostics(status.workspaceId, status.languageId);
    }
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

  if (status.state === "running") missingReported.delete(status.languageId);

  if (status.gaveUp && !previous?.gaveUp && isBuiltinLspPresetLanguageId(status.languageId)) {
    const { workspaceId, languageId } = status;
    if (status.missingBinary) {
      if (missingReported.has(languageId)) return;
      missingReported.add(languageId);
      const install = resolveLspPreset(languageId)?.install;
      showToast({
        kind: "warning",
        // The install command in plain sight: details stay collapsed.
        message: [
          i18next.t("lsp.notFound", { language, binary: status.missingBinary }),
          install ? i18next.t("lsp.installHint", { command: install }) : "",
        ]
          .join(" ")
          .trim(),
        actions: [
          {
            label: i18next.t("lsp.restart"),
            onAction: () => void ipcCallResult("lsp", "restartServer", { workspaceId, languageId }),
          },
          {
            label: i18next.t("lsp.openSettings"),
            onAction: () => useSettingsUIStore.getState().openSettingsAt("editor"),
          },
        ],
      });
      return;
    }
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
