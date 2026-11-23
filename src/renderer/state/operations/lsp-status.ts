import i18next from "i18next";
import { isBuiltinLspPresetLanguageId, resolveLspPreset } from "../../../shared/lsp/config";
import type { LspServerStatus } from "../../../shared/lsp/status";
import { dismissToast, showToast } from "../../components/ui/toast";
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
let evictionExplained = false;
const missingReported = new Set<string>();
const failureToasts = new Map<string, { id: number; languageId: string; missing: boolean }>();

export function initLspStatusSync(): void {
  unlisten?.();
  unregisterCleanup?.();
  unlisten = ipcListen("lsp", "serverStatus", (status) => {
    const store = useLspStatusStore.getState();
    const previous = store.statuses[lspStatusKey(status.workspaceId, status.languageId)];
    if (status.state !== "running") clearProgressFor(status.workspaceId, status.languageId);
    if (status.state === "failed" || (status.state === "stopped" && status.stopReason === "off")) {
      clearLspDiagnostics(status.workspaceId, status.languageId);
    }
    store.setStatus(status);
    notify(status, previous);
  });
  unregisterCleanup = registerWorkspaceCleanup((workspaceId) => {
    useLspStatusStore.getState().forgetWorkspace(workspaceId);
    dismissWorkspaceToasts(workspaceId);
  });
  void ipcCallResult("lsp", "serverStatuses", undefined).then((result) => {
    if (result.ok) useLspStatusStore.getState().hydrate(result.value);
  });
}

function dismissWorkspaceToasts(workspaceId: string): void {
  const prefix = lspStatusKey(workspaceId, "");
  for (const [key, toast] of failureToasts) {
    if (!key.startsWith(prefix)) continue;
    dismissToast(toast.id);
    if (toast.missing) missingReported.delete(toast.languageId);
    failureToasts.delete(key);
  }
}

export function dismissLspFailureToast(workspaceId: string, languageId: string): void {
  const key = lspStatusKey(workspaceId, languageId);
  const toast = failureToasts.get(key);
  if (toast === undefined) return;
  dismissToast(toast.id);
  failureToasts.delete(key);
}

function notify(status: LspServerStatus, previous: LspServerStatus | undefined): void {
  const workspace =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === status.workspaceId)?.name ??
    status.workspaceId;
  const language = i18next.t(`lsp.language.${status.languageId}`, {
    defaultValue: status.languageId,
  });

  if (status.state === "running") {
    missingReported.delete(status.languageId);
    const key = lspStatusKey(status.workspaceId, status.languageId);
    const toast = failureToasts.get(key);
    if (toast) dismissToast(toast.id);
    failureToasts.delete(key);
  }

  if (status.gaveUp && !previous?.gaveUp && isBuiltinLspPresetLanguageId(status.languageId)) {
    const { workspaceId, languageId } = status;
    if (status.missingBinary) {
      if (missingReported.has(languageId)) return;
      missingReported.add(languageId);
      const install = resolveLspPreset(languageId)?.install;
      const toast = showToast({
        kind: "warning",
        message: [
          i18next.t("lsp.notFound", { language, binary: status.missingBinary }),
          install ? i18next.t("lsp.installHint", { command: install }) : "",
        ]
          .join(" ")
          .trim(),
        actions: [
          {
            label: i18next.t("lsp.restart"),
            dedupeKey: lspStatusKey(workspaceId, languageId),
            onAction: () => void ipcCallResult("lsp", "restartServer", { workspaceId, languageId }),
          },
          {
            label: i18next.t("lsp.openSettings"),
            dedupeKey: "language-server-settings",
            onAction: () => useSettingsUIStore.getState().openSettingsAt("language-servers"),
          },
        ],
      });
      failureToasts.set(lspStatusKey(workspaceId, languageId), {
        id: toast,
        languageId,
        missing: true,
      });
      return;
    }
    const toast = showToast({
      kind: "error",
      message: i18next.t("lsp.gaveUp", { workspace, language }),
      details: status.error,
      actions: [
        {
          label: i18next.t("lsp.restart"),
          dedupeKey: lspStatusKey(workspaceId, languageId),
          onAction: () => void ipcCallResult("lsp", "restartServer", { workspaceId, languageId }),
        },
        {
          label: i18next.t("lsp.showLog"),
          dedupeKey: lspStatusKey(workspaceId, languageId),
          onAction: () => useLspLogViewerStore.getState().open({ workspaceId, languageId }),
        },
      ],
    });
    failureToasts.set(lspStatusKey(workspaceId, languageId), {
      id: toast,
      languageId,
      missing: false,
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
