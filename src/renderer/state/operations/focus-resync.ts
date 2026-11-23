import { useActiveStore } from "../stores/active";
import { useFilesStore } from "../stores/files/store";
import { useGitStore } from "../stores/git";
import { scheduleStatusHintRefresh } from "../stores/git/draft-persistence";
import { useWorkspacesStore } from "../stores/workspaces";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import { reloadExpandedDirs } from "./files";

const RESYNC_MIN_INTERVAL_MS = 2_000;

const lastResyncAt = new Map<string, number>();

function resyncWorkspace(workspaceId: string): void {
  if (!useWorkspacesStore.getState().workspaces.some((workspace) => workspace.id === workspaceId)) {
    return;
  }
  const now = Date.now();
  if (now - (lastResyncAt.get(workspaceId) ?? 0) < RESYNC_MIN_INTERVAL_MS) return;
  lastResyncAt.set(workspaceId, now);

  if (useFilesStore.getState().trees.has(workspaceId)) {
    reloadExpandedDirs(workspaceId);
  }
  const session = useGitStore.getState().sessions.get(workspaceId);
  if (session?.repoInfo.kind === "repo") {
    scheduleStatusHintRefresh(workspaceId);
  }
}

function resyncActiveWorkspace(): void {
  const workspaceId = useActiveStore.getState().activeWorkspaceId;
  if (workspaceId) resyncWorkspace(workspaceId);
}

let installed = false;
export function initFocusResync(): void {
  if (installed) return;
  installed = true;
  registerWorkspaceCleanup((workspaceId) => {
    lastResyncAt.delete(workspaceId);
  });

  let leftApp = false;
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!document.hasFocus()) leftApp = true;
    }, 0);
  });
  window.addEventListener("focus", () => {
    if (!leftApp) return;
    leftApp = false;
    resyncActiveWorkspace();
  });

  useActiveStore.subscribe((state, prev) => {
    if (state.activeWorkspaceId && state.activeWorkspaceId !== prev.activeWorkspaceId) {
      resyncWorkspace(state.activeWorkspaceId);
    }
  });
}
