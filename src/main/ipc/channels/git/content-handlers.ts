/**
 * Content handlers — Git object reads used by diff tabs.
 */
import { BINARY_DETECTION_BYTES } from "../../../../shared/fs-defaults";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { FileReadResult } from "../../../../shared/types/fs";
import { isBinaryProbe } from "../../../filesystem/binary-detect";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Maps the ref string to the appropriate missing reason for the discriminated
 * union result. INDEX reads use the ":" prefix objectSpec, so ref===INDEX →
 * "index". Named refs that look like HEAD or a commit SHA → "ref". Path
 * patterns fall back to "path". Everything else → "not-found".
 */
function missingReasonForRef(ref: string): "index" | "ref" | "path" | "not-found" {
  if (ref === "INDEX") return "index";
  if (/^(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|FETCH_HEAD)$/i.test(ref)) return "ref";
  if (/^[0-9a-f]{4,40}$/.test(ref)) return "ref";
  if (ref.includes("/") || ref.includes("..")) return "ref";
  return "not-found";
}

/**
 * Builds the getFileContent handler; Git refs and INDEX read through
 * GitRepository while WORKING is intentionally left to fs.readFile.
 */
export function getFileContentHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<FileReadResult> {
  return async (args: unknown, ctx?: CallContext): Promise<FileReadResult> => {
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

    try {
      const content = await repo.getFileContent(ref, relPath, ctx?.signal);
      return buildGitFileContent(content);
    } catch (err) {
      if (err instanceof GitError && err.kind === "missing") {
        return { kind: "missing", reason: missingReasonForRef(ref) };
      }
      throw err;
    }
  };
}

/**
 * Converts a Git blob string into the FileReadResult "ok" variant expected by
 * editor/diff consumers.
 */
function buildGitFileContent(content: string): FileReadResult & { kind: "ok" } {
  const buf = Buffer.from(content, "utf8");
  const probe = buf.slice(0, BINARY_DETECTION_BYTES);
  const mtime = new Date().toISOString();

  if (isBinaryProbe(probe)) {
    return { kind: "ok", content: "", encoding: "utf8", sizeBytes: buf.byteLength, isBinary: true, mtime };
  }

  if (probe.length >= 3 && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) {
    return {
      kind: "ok",
      content: buf.slice(3).toString("utf8"),
      encoding: "utf8-bom",
      sizeBytes: buf.byteLength,
      isBinary: false,
      mtime,
    };
  }

  return {
    kind: "ok",
    content,
    encoding: "utf8",
    sizeBytes: buf.byteLength,
    isBinary: false,
    mtime,
  };
}
