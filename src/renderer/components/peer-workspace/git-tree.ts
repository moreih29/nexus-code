import { peerGitPaths } from "../../services/remote/peer-git-paths";
import { isPeerGitConflict, type PeerGitStatus } from "../../services/remote/peer-git-status";
import { peerPathKey, peerSearchResultPath } from "../../utils/peer-path";
import {
  type GitDecorationKind,
  letterToKind,
  maxKind,
  propagateToAncestors,
} from "../files/file-tree/git-decoration";

export function peerGitDecorations(root: string, status: PeerGitStatus | undefined) {
  const files = new Map<string, GitDecorationKind>();
  const folders = new Map<string, GitDecorationKind>();
  const rootKey = peerPathKey(root);
  const paths = peerGitPaths(root, status?.topLevel);

  function mark(relative: string, kind: GitDecorationKind) {
    const path = paths.toWorkspace(relative)?.absolute;
    if (!path) return;
    const key = peerPathKey(path);
    const existing = files.get(key);
    files.set(key, existing ? maxKind(existing, kind) : kind);
    propagateToAncestors(folders, key, kind, rootKey);
  }

  for (const file of status?.files ?? []) {
    const kind = isPeerGitConflict(file)
      ? "conflict"
      : (letterToKind(file.unstaged ?? " ") ?? letterToKind(file.staged ?? " "));
    if (kind) mark(file.path, kind);
    if (file.oldPath && file.oldPath !== file.path) mark(file.oldPath, "renamed");
  }
  return { files, folders };
}

function pathsOf(root: string, status: PeerGitStatus | undefined) {
  const mapped = new Map<string, string>();
  const paths = peerGitPaths(root, status?.topLevel);
  for (const { path, oldPath } of status?.files ?? []) {
    for (const gitPath of [path, oldPath]) {
      if (!gitPath) continue;
      const file = paths.toWorkspace(gitPath);
      if (file?.absolute && file.relative) mapped.set(peerPathKey(file.absolute), file.relative);
    }
  }
  return mapped;
}

/** Immediate parents of paths added to or removed from the Git file set. */
export function changedPeerGitParents(
  root: string,
  previous: PeerGitStatus | undefined,
  current: PeerGitStatus | undefined,
): ReadonlySet<string> {
  const before = pathsOf(root, previous);
  const after = pathsOf(root, current);
  const parents = new Set<string>();

  function addMissing(from: Map<string, string>, other: Map<string, string>) {
    for (const [key, relative] of from) {
      if (other.has(key)) continue;
      const slash = relative.lastIndexOf("/");
      const parent = slash === -1 ? root : peerSearchResultPath(root, relative.slice(0, slash));
      if (parent) parents.add(peerPathKey(parent));
    }
  }
  addMissing(before, after);
  addMissing(after, before);
  return parents;
}
