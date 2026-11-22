import { basename } from "../../utils/path";
import { peerSearchResultPath } from "../../utils/peer-path";

/** Display paths separately from the repository-relative keys used by Git RPCs. */
export function peerGitDisplayPath(root: string, gitPath: string) {
  const outsideWorkspace = peerSearchResultPath(root, gitPath) === null;
  const fileName = basename(gitPath);
  return {
    path: gitPath,
    fileName,
    directory: gitPath.slice(0, -fileName.length),
    outsideWorkspace,
  };
}
