import {
  isPeerWindowsPath,
  joinPeerPath,
  peerPathRelativeTo,
  peerSearchResultPath,
} from "../../utils/peer-path";

export function peerGitPaths(workspaceRoot: string, topLevel?: string) {
  const repositoryRoot =
    topLevel && peerPathRelativeTo(workspaceRoot, topLevel) !== null ? topLevel : undefined;

  return {
    toWorkspace(path: string) {
      const absolute = peerSearchResultPath(repositoryRoot ?? workspaceRoot, path);
      if (!absolute) return null;
      if (!repositoryRoot) return { relative: path, absolute };
      const relative = peerPathRelativeTo(absolute, workspaceRoot);
      return relative
        ? { relative, absolute: joinPeerPath(workspaceRoot, relative) }
        : { relative: null, absolute: null };
    },

    toGit(path: string, changes: readonly { path: string }[]): string | null {
      if (!repositoryRoot) return path;
      const relative = peerPathRelativeTo(path, repositoryRoot);
      if (!relative || !peerSearchResultPath(repositoryRoot, relative)) return null;
      if (!isPeerWindowsPath(repositoryRoot)) return relative;
      if (changes.some((change) => change.path === relative)) return relative;
      const key = relative.toLowerCase();
      const matches = changes.filter((change) => change.path.toLowerCase() === key);
      return matches.length === 1 ? matches[0].path : relative;
    },
  };
}
