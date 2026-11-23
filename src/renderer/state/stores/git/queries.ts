import type {
  BranchList,
  LogEntry,
  RemoteTag,
  StashEntry,
  Tag,
} from "../../../../shared/git/types";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { collectRecentCommits } from "./session-defaults";
import type { GitStoreContext } from "./store-context";

export interface QueriesSlice {
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  listRemoteTags: (
    workspaceId: string,
    remote: string,
    signal?: AbortSignal,
  ) => Promise<RemoteTag[] | undefined>;
  listStashes: (workspaceId: string, signal?: AbortSignal) => Promise<StashEntry[] | undefined>;
  listRecentCommits: (
    workspaceId: string,
    signal?: AbortSignal,
    ref?: string,
  ) => Promise<LogEntry[] | undefined>;
}

export function createQueriesSlice(_ctx: GitStoreContext): QueriesSlice {
  return {
    async listBranches(workspaceId, signal) {
      try {
        return unwrapGitResult(
          await ipcCallResult("git", "listBranches", { workspaceId }, signal ? { signal } : {}),
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listTags(workspaceId, signal) {
      try {
        return unwrapGitResult(
          await ipcCallResult("git", "listTags", { workspaceId }, signal ? { signal } : {}),
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listRemoteTags(workspaceId, remote, signal) {
      try {
        return unwrapGitResult(
          await ipcCallResult(
            "git",
            "listRemoteTags",
            { workspaceId, remote },
            signal ? { signal } : {},
          ),
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listStashes(workspaceId, signal) {
      try {
        return unwrapGitResult(
          await ipcCallResult("git", "stashList", { workspaceId }, signal ? { signal } : {}),
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listRecentCommits(workspaceId, signal, ref) {
      try {
        return await collectRecentCommits(workspaceId, signal, ref);
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },
  };
}
