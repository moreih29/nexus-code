/**
 * Content handlers — Git object reads used by diff tabs.
 */
import { BINARY_DETECTION_BYTES } from "../../../../shared/fs-defaults";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { FileContent } from "../../../../shared/types/fs";
import { isBinaryProbe } from "../../../filesystem/binary-detect";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the getFileContent handler; Git refs and INDEX read through
 * GitRepository while WORKING is intentionally left to fs.readFile.
 */
export function getFileContentHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<FileContent> {
  return async (args: unknown, ctx?: CallContext): Promise<FileContent> => {
    const { workspaceId, ref, relPath } = validateArgs(c.getFileContent.args, args);

    if (ref === "WORKING") {
      throw new GitError(
        "unknown",
        "git.getFileContent does not support WORKING refs; use fs.readFile for working-tree content",
      );
    }

    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) {
      throw new GitError("not-repo", "Not a Git repository");
    }

    const content = await repo.getFileContent(ref, relPath, ctx?.signal);
    return buildGitFileContent(content);
  };
}

/**
 * Converts a Git blob string into the FileContent contract shape expected by
 * editor/diff consumers.
 */
function buildGitFileContent(content: string): FileContent {
  const buf = Buffer.from(content, "utf8");
  const probe = buf.slice(0, BINARY_DETECTION_BYTES);
  const mtime = new Date().toISOString();

  if (isBinaryProbe(probe)) {
    return { content: "", encoding: "utf8", sizeBytes: buf.byteLength, isBinary: true, mtime };
  }

  if (probe.length >= 3 && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) {
    return {
      content: buf.slice(3).toString("utf8"),
      encoding: "utf8-bom",
      sizeBytes: buf.byteLength,
      isBinary: false,
      mtime,
    };
  }

  return {
    content,
    encoding: "utf8",
    sizeBytes: buf.byteLength,
    isBinary: false,
    mtime,
  };
}
