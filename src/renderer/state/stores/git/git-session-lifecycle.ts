/**
 * git-session-lifecycle.ts — slice creator.
 *
 * Slice: loadInitial, refresh, init, closeAllForWorkspace, plus the
 * session upsert/update primitives are in git-store-context.ts.
 */

import type { RepoInfo } from "../../../../shared/git/types";
import { ipcCall } from "../../../ipc/client";
import { cancelCommitDraftSave, cancelStatusHintRefresh } from "../git-draft-persistence";
import { firstRejectedReason, gitStoreErrorFromUnknown } from "../git-store-helpers";
import { createDefaultSession } from "../git-session-defaults";
import type { GitStoreContext } from "./git-store-context";

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

      const [repoInfoResult, statusResult, panelStateResult] =
        await Promise.allSettled([
          ipcCall("git", "getRepoInfo", { workspaceId }),
          ipcCall("git", "getStatus", { workspaceId }),
          ipcCall("git", "getPanelState", { workspaceId }),
        ]);

      updateExistingSession(workspaceId, (session) => {
        const firstError = firstRejectedReason(
          repoInfoResult,
          statusResult,
          panelStateResult,
        );
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
          expandedTreeNodes:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedTreeNodes }
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
        const repoInfo = await ipcCall("git", "refreshDetection", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
      });
    },

    async init(workspaceId) {
      return runOperation(workspaceId, "init", async (signal) => {
        const repoInfo = await ipcCall("git", "init", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
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
