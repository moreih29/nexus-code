import {
  isPeerGitConflict,
  type PeerGitFile,
  type PeerGitSide,
} from "../../services/remote/peer-git-status";
import type { ChangeCounts } from "../workbench/status-bar-items";

export type PeerGitGroupKey = "merge" | "staged" | "working" | "untracked";

export const PEER_GIT_GROUPS: readonly { key: PeerGitGroupKey; side: PeerGitSide }[] = [
  { key: "merge", side: "unstaged" },
  { key: "staged", side: "staged" },
  { key: "working", side: "unstaged" },
  { key: "untracked", side: "unstaged" },
];

export function peerGitGroupsOf(file: PeerGitFile): PeerGitGroupKey[] {
  if (isPeerGitConflict(file)) return ["merge"];
  const groups: PeerGitGroupKey[] = [];
  if (file.staged && file.staged !== "?") groups.push("staged");
  if (file.unstaged === "?") groups.push("untracked");
  else if (file.unstaged) groups.push("working");
  return groups;
}

export function peerGitGroups(
  files: readonly PeerGitFile[],
): Record<PeerGitGroupKey, PeerGitFile[]> {
  const groups: Record<PeerGitGroupKey, PeerGitFile[]> = {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
  };
  for (const file of files) for (const key of peerGitGroupsOf(file)) groups[key].push(file);
  return groups;
}

export function peerGitCounts(files: readonly PeerGitFile[]): ChangeCounts {
  const groups = peerGitGroups(files);
  return {
    conflict: groups.merge.length,
    staged: groups.staged.length,
    modified: groups.working.length,
    untracked: groups.untracked.length,
  };
}
