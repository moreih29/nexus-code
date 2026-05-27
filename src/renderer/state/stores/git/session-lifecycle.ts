/**
 * git-session-lifecycle.ts — slice creator.
 *
 * Slice: loadInitial, refresh, init, closeAllForWorkspace, plus the
 * session upsert/update primitives are in git-store-context.ts.
 */

import type { RepoInfo } from "../../../../shared/git/types";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { cancelCommitDraftSave, cancelStatusHintRefresh } from "./draft-persistence";
import { sanitizeExpandedTreeNodes } from "./panel-ui";
import { createDefaultSession } from "./session-defaults";
import type { GitStoreContext } from "./store-context";
import { firstRejectedReason, gitStoreErrorFromUnknown } from "./store-helpers";

export interface SessionLifecycleSlice {
  loadInitial: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  init: (workspaceId: string) => Promise<RepoInfo | undefined>;
  closeAllForWorkspace: (workspaceId: string) => void;
}

export function createSessionLifecycleSlice(ctx: GitStoreContext): SessionLifecycleSlice {
  const { set, get, controllers, updateExistingSession, upsertSession, runOperation } = ctx;

  return {
    async loadInitial(workspaceId) {
      if (get().sessions.has(workspaceId)) return;

      set((state) => {
        if (state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.set(workspaceId, createDefaultSession({ statusFetching: true }));
        return { sessions: next };
      });

      // Fetch repo info, status, and panel state in parallel. Each call uses
      // ipcCallResult so IpcErrResult("git-error") or "cancelled" are returned
      // as values rather than rejections, preserving allSettled semantics for
      // partial load resilience.
      const [repoInfoResult, statusResult, panelStateResult] = await Promise.allSettled([
        ipcCallResult("git", "getRepoInfo", { workspaceId }).then(unwrapGitResult),
        ipcCallResult("git", "getStatus", { workspaceId }).then(unwrapGitResult),
        ipcCallResult("git", "getPanelState", { workspaceId }).then(unwrapGitResult),
      ]);

      updateExistingSession(workspaceId, (session) => {
        const firstError = firstRejectedReason(repoInfoResult, statusResult, panelStateResult);
        return {
          ...session,
          repoInfo: repoInfoResult.status === "fulfilled" ? repoInfoResult.value : session.repoInfo,
          status: statusResult.status === "fulfilled" ? statusResult.value : session.status,
          statusFetching: false,
          branchInfo:
            statusResult.status === "fulfilled" ? statusResult.value.branch : session.branchInfo,
          commitDraft:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.commitDraft
              : session.commitDraft,
          expandedGroups:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedGroups }
              : session.expandedGroups,
          // Sanitize persisted directory paths against the fresh status —
          // paths that no longer correspond to a directory in the current
          // tree (file committed, discarded, or staged into a different
          // group between sessions) get dropped here so the header
          // expand/collapse toggle's `hasAnyExpanded` count reflects what
          // the user actually sees in the panel. Without this, the toggle
          // shows "already expanded" against visibly-collapsed folders.
          expandedTreeNodes:
            panelStateResult.status === "fulfilled"
              ? sanitizeExpandedTreeNodes(
                  { ...panelStateResult.value.expandedTreeNodes },
                  statusResult.status === "fulfilled" ? statusResult.value : null,
                )
              : session.expandedTreeNodes,
          commitOptions:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.commitOptions }
              : session.commitOptions,
          autofetchIntervalMin:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.autofetchIntervalMin
              : session.autofetchIntervalMin,
          autofetchManualPaused:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.autofetchManualPaused
              : session.autofetchManualPaused,
          panelSegment:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.panelSegment
              : session.panelSegment,
          historyRef:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.historyRef
              : session.historyRef,
          historyScope:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.historyScope
              : session.historyScope,
          lastError: firstError ? gitStoreErrorFromUnknown(firstError) : null,
        };
      });
    },

    async refresh(workspaceId) {
      await runOperation(workspaceId, "refresh", async (signal) => {
        const repoInfo = unwrapGitResult(
          await ipcCallResult("git", "refreshDetection", { workspaceId }, { signal }),
        );
        const status = unwrapGitResult(
          await ipcCallResult("git", "getStatus", { workspaceId }, { signal }),
        );
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          // Re-align expanded directory paths with the fresh status — see
          // loadInitial for the rationale. A refresh can wipe a directory
          // out of the tree (commit, discard, gitignore) without the user
          // touching the toggle, so the invariant must hold here too.
          expandedTreeNodes: sanitizeExpandedTreeNodes(session.expandedTreeNodes, status),
          lastError: null,
        }));
      });
    },

    async init(workspaceId) {
      return runOperation(workspaceId, "init", async (signal) => {
        const repoInfo = unwrapGitResult(
          await ipcCallResult("git", "init", { workspaceId }, { signal }),
        );
        const status = unwrapGitResult(
          await ipcCallResult("git", "getStatus", { workspaceId }, { signal }),
        );
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
        return repoInfo;
      });
    },

    closeAllForWorkspace(workspaceId) {
      const ctrl = controllers.get(workspaceId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(workspaceId);
      }
      cancelCommitDraftSave(workspaceId);
      cancelStatusHintRefresh(workspaceId);
      set((state) => {
        if (!state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.delete(workspaceId);
        return { sessions: next };
      });
    },
  };
}
