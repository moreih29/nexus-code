/**
 * Per-workspace commit-draft and passive status-hint debouncing for the git
 * store.
 *
 * Two queues live here: pending commit drafts (debounced by
 * `GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS` so a typing burst collapses into a
 * single write) and pending status refreshes (debounced by
 * `GIT_STATUS_HINT_DEBOUNCE_MS` so a working-tree edit burst triggers at
 * most one `git status` re-fetch). Keeping both in a dedicated module
 * isolates the timer/Map bookkeeping from the rest of the store body.
 */

import {
  GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS,
  GIT_STATUS_HINT_DEBOUNCE_MS,
} from "../../../../shared/util/timing-constants";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { useGitStore } from "./index";
import { persistPanelState } from "./panel-state-io";

const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDraftSaves = new Map<string, string>();
const statusHintTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a per-workspace commit-draft write; repeated keystrokes reset
 * the same timer so only the final value reaches storage.
 */
export function scheduleCommitDraftSave(workspaceId: string, commitDraft: string): void {
  pendingDraftSaves.set(workspaceId, commitDraft);

  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    flushCommitDraftSave(workspaceId);
  }, GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS);
  draftSaveTimers.set(workspaceId, handle);
}

/**
 * Cancel the pending draft persistence for a workspace without writing it.
 */
export function cancelCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }
  pendingDraftSaves.delete(workspaceId);
}

/**
 * Flush one workspace's pending draft write immediately.
 */
export function flushCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }

  if (!pendingDraftSaves.has(workspaceId)) return;

  const commitDraft = pendingDraftSaves.get(workspaceId) ?? "";
  pendingDraftSaves.delete(workspaceId);
  persistPanelState(workspaceId, { commitDraft });
}

/**
 * Flush all queued draft writes, used by blur/visibilitychange and exposed
 * on the store for explicit input blur handlers.
 */
export function flushAllCommitDraftSaves(): void {
  for (const workspaceId of Array.from(pendingDraftSaves.keys())) {
    flushCommitDraftSave(workspaceId);
  }
}

/**
 * Working-tree file changes do not always touch .git metadata. Treat fs.changed
 * as a passive status hint and refresh without claiming the operation spinner.
 */
export function scheduleStatusHintRefresh(workspaceId: string): void {
  const existing = statusHintTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    statusHintTimers.delete(workspaceId);
    void refreshStatusFromHint(workspaceId);
  }, GIT_STATUS_HINT_DEBOUNCE_MS);
  statusHintTimers.set(workspaceId, handle);
}

/**
 * Cancel a queued passive status hint when the workspace session disappears.
 */
export function cancelStatusHintRefresh(workspaceId: string): void {
  const existing = statusHintTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  statusHintTimers.delete(workspaceId);
}

/**
 * Pull one status snapshot in response to an fs.changed hint. This
 * intentionally avoids beginOperation() so it cannot abort a user-initiated
 * git operation.
 */
async function refreshStatusFromHint(workspaceId: string): Promise<void> {
  const current = useGitStore.getState().sessions.get(workspaceId);
  if (!current || current.repoInfo.kind !== "repo") return;

  try {
    const status = unwrapGitResult(await ipcCallResult("git", "getStatus", { workspaceId }));
    useGitStore.setState((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session || session.repoInfo.kind !== "repo") return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, {
        ...session,
        status,
        branchInfo: status.branch,
      });
      return { sessions: next };
    });
  } catch (error) {
    console.warn("[git] passive status refresh failed", error);
  }
}

/**
 * Flush pending draft writes before the renderer loses focus or becomes
 * hidden, covering input blur and app-background paths without UI code.
 */
export function installCommitDraftFlushListeners(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;

  window.addEventListener("blur", flushAllCommitDraftSaves);

  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAllCommitDraftSaves();
    }
  });
}
