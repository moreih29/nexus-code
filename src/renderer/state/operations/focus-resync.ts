/**
 * Watcher safety net: re-read the file tree and git status of the active
 * workspace when the user comes back to the app or switches workspaces.
 *
 * The tree and the git panel are event-driven (fs.changed / git.statusChanged)
 * and only as fresh as the watchers behind them. Some changes can't be
 * observed at all — a working-tree edit in a collapsed folder never reaches
 * git status, a remote host can run out of inotify instances, events are lost
 * while the agent is down. Coming back to the window after working elsewhere
 * (a terminal, another editor) is exactly when those gaps show, so that is
 * when we resync. Mirrors VS Code, which refreshes git status on focus.
 */

import { useActiveStore } from "../stores/active";
import { useFilesStore } from "../stores/files/store";
import { useGitStore } from "../stores/git";
import { scheduleStatusHintRefresh } from "../stores/git/draft-persistence";
import { reloadExpandedDirs } from "./files";

/** Floor between resyncs, so rapid alt-tabbing doesn't stack readdirs. */
const RESYNC_MIN_INTERVAL_MS = 2_000;

const lastResyncAt = new Map<string, number>();

function resyncWorkspace(workspaceId: string): void {
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

  // Focus moving into one of our own iframes (the HTML preview) also blurs
  // the top window, but the document keeps focus then. Only a blur that
  // leaves `document.hasFocus()` false is a real switch away from the app;
  // hasFocus() settles after the event, hence the task hop.
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

  // An inactive workspace's tree keeps its watchers, but its git status is
  // not refreshed for working-tree changes outside watched folders.
  useActiveStore.subscribe((state, prev) => {
    if (state.activeWorkspaceId && state.activeWorkspaceId !== prev.activeWorkspaceId) {
      resyncWorkspace(state.activeWorkspaceId);
    }
  });
}
