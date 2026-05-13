/**
 * Shared Git text-stream chunker for diff-shaped outputs.
 *
 * `git diff`, `git stash show --patch`, and future history detail views all
 * expose large UTF-8 text streams with the same IPC contract: bounded text
 * chunks plus a byte-count completion payload. This module owns the byte
 * boundary and UTF-8 decoder behavior so each caller only supplies argv.
 */
import { StringDecoder } from "node:string_decoder";
import type { DiffChunk, DiffComplete } from "../../shared/types/git";
import { type GitProcessExecutor, streamGit } from "./git-process";

export const GIT_DIFF_CHUNK_MAX_BYTES = 1024 * 1024;

export interface GitTextStreamOptions {
  readonly bin: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly maxChunkBytes?: number;
  readonly executor?: GitProcessExecutor;
}

export interface ChunkGitTextStreamOptions {
  readonly signal?: AbortSignal;
  readonly maxChunkBytes?: number;
}

/**
 * Runs a Git command and yields stdout as bounded UTF-8 text chunks.
 */
export async function* streamGitTextChunks({
  bin,
  cwd,
  args,
  signal,
  maxChunkBytes = GIT_DIFF_CHUNK_MAX_BYTES,
  executor,
}: GitTextStreamOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
  return yield* chunkGitTextStream(
    streamGit({ bin, cwd, args, interactive: false, signal, executor }),
    {
      signal,
      maxChunkBytes,
    },
  );
}

/**
 * Chunks any Buffer async iterable on byte boundaries without splitting UTF-8
 * code points in the emitted text. Exported for focused unit tests and for
 * callers that already own process streaming.
 */
export async function* chunkGitTextStream(
  chunks: AsyncIterable<Buffer>,
  { signal, maxChunkBytes = GIT_DIFF_CHUNK_MAX_BYTES }: ChunkGitTextStreamOptions = {},
): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
  if (maxChunkBytes < 1) {
    throw new Error("maxChunkBytes must be at least 1");
  }

  const decoder = new StringDecoder("utf8");
  const buffers: Buffer[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;

  /** Flushes the current byte buffer through StringDecoder. */
  const flush = (): DiffChunk | null => {
    if (bufferedBytes === 0) return null;
    const text = decoder.write(Buffer.concat(buffers, bufferedBytes));
    buffers.length = 0;
    bufferedBytes = 0;
    return text.length > 0 ? { text } : null;
  };

  throwIfAborted(signal);
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    totalBytes += chunk.byteLength;

    let offset = 0;
    while (offset < chunk.byteLength) {
      throwIfAborted(signal);
      const remainingCapacity = maxChunkBytes - bufferedBytes;
      const take = Math.min(remainingCapacity, chunk.byteLength - offset);
      buffers.push(chunk.subarray(offset, offset + take));
      bufferedBytes += take;
      offset += take;

      if (bufferedBytes >= maxChunkBytes) {
        const flushed = flush();
        if (flushed) yield flushed;
      }
    }
  }

  throwIfAborted(signal);
  const flushed = flush();
  if (flushed) yield flushed;
  const trailing = decoder.end();
  if (trailing.length > 0) yield { text: trailing };

  return { bytes: totalBytes, truncated: false };
}

/**
 * Throws the standard AbortError shape used by Git stream callers.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}
