import { isBinaryProbe } from "../../../../shared/fs/binary-detect";
import { BINARY_DETECTION_BYTES } from "../../../../shared/fs/defaults";
import type { GitOpenFileAtHeadResult } from "../../../../shared/git/types";
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

function blobTooLargeError(relPath: string): GitError {
  return new GitError("binary-too-large", `Git blob ${relPath} exceeds text read limit`, {
    argv: ["blob", "HEAD", relPath],
  });
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}
