import { peerGitPaths } from "../../services/remote/peer-git-paths";
import { basename } from "../../utils/path";

/** Display paths separately from the repository-relative keys used by Git RPCs. */
export function peerGitDisplayPath(root: string, gitPath: string, topLevel?: string) {
  const relative = peerGitPaths(root, topLevel).toWorkspace(gitPath)?.relative;
  const path = relative ?? gitPath;
  const fileName = basename(path);
  return {
    path,
    fileName,
    directory: path.slice(0, -fileName.length),
    outsideWorkspace: relative == null,
  };
}
