/**
 * Reads a bounded HEAD blob through the semantic blob executor and decodes
 * it as text once binary and size guards pass. Lives next to
 * `GitRepository` rather than inside it because the read+decode flow has
 * its own responsibility — binary detection, BOM stripping, UTF-8 decode,
 * and the size envelope — that is independent of repository state.
 */
import { BINARY_DETECTION_BYTES } from "../../../../shared/fs/defaults";
import { isBinaryProbe } from "../../../../shared/fs/binary-detect";
import type { GitOpenFileAtHeadResult } from "../../../../shared/types/git";
import type { GitExecutor } from "../bridge/types";
import { GitError } from "./error";

const GIT_OPEN_FILE_AT_HEAD_MAX_BYTES = 1024 * 1024;

const noop = (): void => undefined;

export interface ReadHeadBlobOptions {
  readonly executor: GitExecutor;
  readonly topLevel: string;
  readonly relPath: string;
  readonly signal: AbortSignal;
}

/**
 * Streams the HEAD blob bytes, throws on binary content or oversized
 * payloads, strips the UTF-8 BOM when present, and returns the decoded
 * text alongside the encoding label and observed byte count.
 */
export async function readHeadBlobAsText(
  options: ReadHeadBlobOptions,
): Promise<GitOpenFileAtHeadResult> {
  const { executor, topLevel, relPath, signal } = options;
  if (relPath.trim().length === 0) throw new GitError("unknown", "File path is required");

  if (!executor.blob) {
    throw new GitError("unknown", "Git blob executor is unavailable");
  }

  const stream = executor.blob({
    cwd: topLevel,
    ref: "HEAD",
    relPath,
    maxBytes: GIT_OPEN_FILE_AT_HEAD_MAX_BYTES,
    signal,
  });
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  for (;;) {
    const next = await stream.next();
    if (next.done) {
      if (next.value.bytes > GIT_OPEN_FILE_AT_HEAD_MAX_BYTES) {
        throw blobTooLargeError(relPath);
      }
      break;
    }

    const chunk = Buffer.from(next.value.chunk);
    sizeBytes += chunk.byteLength;
    if (sizeBytes > GIT_OPEN_FILE_AT_HEAD_MAX_BYTES) {
      await stream.return({ bytes: sizeBytes }).catch(noop);
      throw blobTooLargeError(relPath);
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks, sizeBytes);
  if (isBinaryProbe(buffer.subarray(0, BINARY_DETECTION_BYTES))) {
    throw new GitError("binary-too-large", `Binary file ${relPath} cannot be opened as text`, {
      argv: ["blob", "HEAD", relPath],
    });
  }

  if (hasUtf8Bom(buffer)) {
    return {
      content: buffer.subarray(3).toString("utf8"),
      encoding: "utf8-bom",
      sizeBytes,
    };
  }

  return { content: buffer.toString("utf8"), encoding: "utf8", sizeBytes };
}

/**
 * Creates the user-facing error for HEAD blob reads that exceed text limits.
 */
function blobTooLargeError(relPath: string): GitError {
  return new GitError("binary-too-large", `Git blob ${relPath} exceeds text read limit`, {
    argv: ["blob", "HEAD", relPath],
  });
}

/**
 * Detects a UTF-8 byte-order mark without converting the whole buffer first.
 */
function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}
