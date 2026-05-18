/**
 * git-queries.ts — slice creator.
 *
 * INVARIANT: These queries intentionally skip the operation lifecycle
 * (beginOperation/finishOperation/runOperation). They are read-only,
 * abortable, and do NOT set inFlightOp or lastError on the session.
 * Failures are surfaced only as thrown errors (which callers can catch)
 * or as undefined returns when the signal is aborted.
 *
 * Slice: listBranches, listTags, listRemoteTags, listStashes,
 * listRecentCommits.
 */

import type {
  BranchList,
  LogEntry,
  RemoteTag,
  StashEntry,
  Tag,
} from "../../../../shared/git/types";
import { ipcCall } from "../../../ipc/client";
import { collectRecentCommits } from "../git-session-defaults";
import type { GitStoreContext } from "./git-store-context";

export interface QueriesSlice {
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  listRemoteTags: (workspaceId: string, remote: string, signal?: AbortSignal) => Promise<RemoteTag[] | undefined>;
  listStashes: (workspaceId: string, signal?: AbortSignal) => Promise<StashEntry[] | undefined>;
  listRecentCommits: (workspaceId: string, signal?: AbortSignal, ref?: string) => Promise<LogEntry[] | undefined>;
}

// ctx is accepted for API consistency with other slice creators even though
// these queries do not need ctx helpers.
export function createQueriesSlice(_ctx: GitStoreContext): QueriesSlice {
  return {
    async listBranches(workspaceId, signal) {
      try {
        return await ipcCall("git", "listBranches", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listTags(workspaceId, signal) {
      try {
        return await ipcCall("git", "listTags", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listRemoteTags(workspaceId, remote, signal) {
      try {
        return await ipcCall(
          "git",
          "listRemoteTags",
          { workspaceId, remote },
          signal ? { signal } : {},
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listStashes(workspaceId, signal) {
      try {
        return await ipcCall("git", "stashList", { workspaceId }, signal ? { signal } : {});
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
