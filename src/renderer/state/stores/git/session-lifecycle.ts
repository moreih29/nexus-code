import type { RepoInfo } from "../../../../shared/git/types";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { deleteCommitDraft, setCommitDraftText } from "./commit-drafts";
import { cancelCommitDraftSave, cancelStatusHintRefresh } from "./draft-persistence";
import { sanitizeExpandedTreeNodes } from "./panel-ui";
import { createDefaultSession } from "./session-defaults";
import type { GitStoreContext } from "./store-context";
import { firstRejectedReason, gitStoreErrorFromUnknown, withSlashTopLevel } from "./store-helpers";

export interface SessionLifecycleSlice {
  loadInitial: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  init: (workspaceId: string) => Promise<RepoInfo | undefined>;
  closeAllForWorkspace: (workspaceId: string) => void;
}

export function createSessionLifecycleSlice(ctx: GitStoreContext): SessionLifecycleSlice {
  const { set, get, controllers, updateExistingSession, runOperation } = ctx;

  return {
    async loadInitial(workspaceId) {
      if (get().sessions.has(workspaceId)) return;

      set((state) => {
        if (state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.set(workspaceId, createDefaultSession({ statusFetching: true }));
        return { sessions: next };
      });

      const [repoInfoResult, statusResult, panelStateResult] = await Promise.allSettled([
        ipcCallResult("git", "getRepoInfo", { workspaceId })
          .then(unwrapGitResult)
          .then(withSlashTopLevel),
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
          expandedGroups:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedGroups }
              : session.expandedGroups,
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
      if (panelStateResult.status === "fulfilled" && get().sessions.has(workspaceId)) {
        setCommitDraftText(workspaceId, panelStateResult.value.commitDraft);
      }
    },

    async refresh(workspaceId) {
      await runOperation(workspaceId, "refresh", async (signal) => {
        const repoInfo = withSlashTopLevel(
          unwrapGitResult(
            await ipcCallResult("git", "refreshDetection", { workspaceId }, { signal }),
          ),
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
          expandedTreeNodes: sanitizeExpandedTreeNodes(session.expandedTreeNodes, status),
          lastError: null,
        }));
      });
    },

    async init(workspaceId) {
      return runOperation(workspaceId, "init", async (signal) => {
        const repoInfo = withSlashTopLevel(
          unwrapGitResult(await ipcCallResult("git", "init", { workspaceId }, { signal })),
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
      const running = controllers.get(workspaceId);
      if (running) {
        for (const ctrl of running.keys()) ctrl.abort();
        controllers.delete(workspaceId);
      }
      cancelCommitDraftSave(workspaceId);
      deleteCommitDraft(workspaceId);
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
