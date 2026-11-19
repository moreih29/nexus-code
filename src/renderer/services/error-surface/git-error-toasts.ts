/**
 * Git failure → toast subscription.
 *
 * The Source Control panel shows only the failures it can recover from (see
 * gitErrorPlacement). Every other failed action surfaces here as a toast, so
 * it is seen even when the panel is not on screen, with git's output under
 * Details. A panel failure raised while the panel is not on screen gets a
 * toast too, pointing the user to it.
 */

import i18next from "i18next";
import { showToast } from "../../components/ui/toast";
import { focusWorkspace } from "../../state/operations/workspace-selection";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useGitStore } from "../../state/stores/git";
import type { GitStoreError } from "../../state/stores/git/types";
import { FILES_PANEL_MODE_DEFAULT, useUIStore } from "../../state/stores/ui";
import { gitErrorPlacement, summarizeGitError } from "./git-error-placement";

type Unsubscribe = () => void;

let activeUnsub: Unsubscribe | null = null;

/**
 * Install (or reinstall) the git failure toast subscription.
 *
 * Safe to call multiple times — the previous subscription is removed first.
 * Failures already recorded when it is installed are not toasted.
 */
export function initGitErrorToasts(): void {
  activeUnsub?.();

  const seen = new Map<string, GitStoreError | null>();
  for (const [workspaceId, session] of useGitStore.getState().sessions) {
    seen.set(workspaceId, session.lastError);
  }

  activeUnsub = useGitStore.subscribe((state) => {
    for (const [workspaceId, session] of state.sessions) {
      const error = session.lastError;
      if (seen.get(workspaceId) === error) continue;
      seen.set(workspaceId, error);
      if (error) surfaceGitError(workspaceId, error);
    }
    for (const workspaceId of seen.keys()) {
      if (!state.sessions.has(workspaceId)) seen.delete(workspaceId);
    }
  });
}

function surfaceGitError(workspaceId: string, error: GitStoreError): void {
  const placement = gitErrorPlacement(error);
  if (placement === "status") return;

  const { summary, details } = summarizeGitError(error);
  if (placement === "toast") {
    showToast({ kind: "error", message: summary, details });
    return;
  }

  if (isSourceControlVisible(workspaceId)) return;
  showToast({
    kind: "error",
    message: summary,
    actions: [
      {
        label: i18next.t("files:git.panelActions.openSourceControl"),
        dedupeKey: `source-control:${workspaceId}`,
        onAction: () => revealSourceControl(workspaceId),
      },
    ],
  });
}

function isSourceControlVisible(workspaceId: string): boolean {
  const ui = useUIStore.getState();
  return (
    useAgentViewStore.getState().mode === "workspace" &&
    useActiveStore.getState().activeWorkspaceId === workspaceId &&
    !ui.filesPanelHidden &&
    (ui.filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT) === "git"
  );
}

function revealSourceControl(workspaceId: string): void {
  focusWorkspace(workspaceId, "workspace");
  const ui = useUIStore.getState();
  if (ui.filesPanelHidden) ui.toggleFilesPanel();
  ui.setFilesPanelMode(workspaceId, "git");
}
