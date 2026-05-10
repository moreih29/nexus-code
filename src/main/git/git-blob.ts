/**
 * Git blob readers used by file context menus and future diff/open flows.
 *
 * The implementation uses `git cat-file --batch` so large blobs stream through
 * stdout without forcing `runGit` to buffer the entire object in memory.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { BINARY_DETECTION_BYTES } from "../../shared/fs-defaults";
import type { GitBlobChunk, GitOpenFileAtHeadResult } from "../../shared/types/git";
import { isBinaryProbe } from "../filesystem/binary-detect";
import { GitError, gitErrorFromExit, gitMissingError, unknownGitError } from "./git-error";

export const GIT_OPEN_FILE_AT_HEAD_MAX_BYTES = 1024 * 1024;

interface GitBlobCommandContext {
  readonly bin: string;
  readonly cwd: string;
}

interface BatchHeader {
  readonly type: string;
  readonly size: number;
}

interface BatchStreamOptions {
  readonly maxBytes?: number;
}

type GitCatFileProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Reads a HEAD blob as UTF-8 text for the lightweight "open at HEAD" IPC.
 * Binary blobs and text blobs above the bounded read size surface as the
 * existing `binary-too-large` GitError kind so callers do not render garbage.
 */
export async function readAtHead(
  repo: GitBlobCommandContext,
  relPath: string,
  signal?: AbortSignal,
): Promise<GitOpenFileAtHeadResult> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  for await (const chunk of streamBlobBytes(repo, "HEAD", relPath, signal, {
    maxBytes: GIT_OPEN_FILE_AT_HEAD_MAX_BYTES,
  })) {
    sizeBytes += chunk.byteLength;
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks, sizeBytes);
  if (isBinaryProbe(buffer.subarray(0, BINARY_DETECTION_BYTES))) {
    throw new GitError("binary-too-large", `Binary file ${relPath} cannot be opened as text`, {
      argv: ["cat-file", "--batch"],
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
 * Streams a blob from any Git ref as Uint8Array chunks. The complete result is
 * the total byte count yielded to IPC consumers.
 */
export async function* streamBlob(
  repo: GitBlobCommandContext,
  ref: string,
  relPath: string,
  signal?: AbortSignal,
): AsyncGenerator<GitBlobChunk, { bytes: number }, unknown> {
  let bytes = 0;
  for await (const chunk of streamBlobBytes(repo, ref, relPath, signal)) {
    bytes += chunk.byteLength;
    yield { chunk: toPlainUint8Array(chunk) };
  }
  return { bytes };
}

/**
 * Streams raw blob bytes after parsing the `cat-file --batch` header and
 * translating missing-path rows into typed Git errors.
 */
async function* streamBlobBytes(
  repo: GitBlobCommandContext,
  ref: string,
  relPath: string,
  signal?: AbortSignal,
  options: BatchStreamOptions = {},
): AsyncGenerator<Buffer, number, unknown> {
  throwIfAborted(signal);

  const normalizedRelPath = normalizeGitRelPath(relPath);
  const normalizedRef = normalizeGitRef(ref);
  const objectSpec = `${normalizedRef}:${normalizedRelPath}`;
  const args = ["cat-file", "--batch"];
  const child = spawnCatFile(repo, args, signal);
  const stderrChunks: Buffer[] = [];
  let pendingFailure: Error | null = null;
  let closed = false;
  let parsedHeader: BatchHeader | null = null;
  let pending = Buffer.alloc(0);
  let remainingBytes = 0;
  let emittedBytes = 0;

  /** Converts external cancellation into an AbortError and stops git. */
  const onAbort = (): void => {
    if (!pendingFailure) pendingFailure = createAbortError();
    killChild(child);
  };

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        pendingFailure = gitMissingError(repo.bin, args, error);
        return;
      }
      pendingFailure = unknownGitError(error.message, args, error);
    });
    child.on("close", (code, processSignal) => {
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: processSignal });
    });
  });

  signal?.addEventListener("abort", onAbort, { once: true });
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin.end(`${objectSpec}\n`);

  try {
    for await (const rawChunk of child.stdout) {
      if (pendingFailure) break;
      pending = Buffer.concat([pending, Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)]);

      if (!parsedHeader) {
        const headerEnd = pending.indexOf(0x0a);
        if (headerEnd === -1) continue;

        const headerLine = pending.subarray(0, headerEnd).toString("utf8");
        pending = pending.subarray(headerEnd + 1);
        parsedHeader = parseBatchHeader(headerLine, normalizedRef, normalizedRelPath, args);
        remainingBytes = parsedHeader.size;

        if (options.maxBytes !== undefined && parsedHeader.size > options.maxBytes) {
          throw new GitError(
            "binary-too-large",
            `Git blob ${normalizedRelPath} exceeds ${options.maxBytes} byte read limit`,
            { argv: args },
          );
        }
      }

      while (parsedHeader && remainingBytes > 0 && pending.byteLength > 0) {
        const take = Math.min(remainingBytes, pending.byteLength);
        const out = pending.subarray(0, take);
        pending = pending.subarray(take);
        remainingBytes -= take;
        emittedBytes += out.byteLength;
        yield out;
      }
    }

    const result = await exit;
    if (pendingFailure) throw pendingFailure;
    if (!parsedHeader) {
      throw new GitError("unknown", "git cat-file did not return a blob header", { argv: args });
    }
    if (remainingBytes > 0) {
      throw new GitError("unknown", "git cat-file ended before the blob was fully read", {
        argv: args,
      });
    }
    if (result.code !== 0) {
      throw gitErrorFromExit({
        args,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: result.code,
        signal: result.signal,
      });
    }

    return emittedBytes;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!closed) {
      killChild(child);
      await exit.catch(() => {});
    }
  }
}

/** Starts a non-interactive `git cat-file --batch` process. */
function spawnCatFile(
  repo: GitBlobCommandContext,
  args: readonly string[],
  signal?: AbortSignal,
): GitCatFileProcess {
  throwIfAborted(signal);
  return spawn(repo.bin, [...args], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
      SSH_ASKPASS_REQUIRE: "force",
      SSH_ASKPASS: "echo",
      GIT_FLUSH: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Parses a single `cat-file --batch` header row. */
function parseBatchHeader(
  headerLine: string,
  ref: string,
  relPath: string,
  argv: readonly string[],
): BatchHeader {
  if (headerLine.endsWith(" missing")) {
    const kind = ref === "HEAD" ? "file-not-in-head" : "missing";
    throw new GitError(kind, `Path ${relPath} does not exist in ${ref}`, { argv });
  }

  const [objectName, type, sizeText] = headerLine.split(" ");
  const size = Number(sizeText);
  if (!objectName || !type || !Number.isInteger(size) || size < 0) {
    throw new GitError("unknown", `Unexpected git cat-file header: ${headerLine}`, { argv });
  }
  if (type !== "blob") {
    throw new GitError("file-not-in-head", `Path ${relPath} in ${ref} is not a file blob`, {
      argv,
    });
  }
  return { type, size };
}

/** Normalizes and validates a repository-relative Git path. */
function normalizeGitRelPath(relPath: string): string {
  const slashPath = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = slashPath.split("/").filter((part) => part.length > 0).join("/");
  if (
    normalized.length === 0 ||
    slashPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new GitError("path-not-in-repo", `Path ${relPath} is outside repository`);
  }
  return normalized;
}

/** Rejects empty or NUL-containing refs before they reach git argv. */
function normalizeGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new GitError("missing", "Git ref is required");
  }
  return trimmed;
}

/** Detects a UTF-8 byte-order mark without converting the whole buffer first. */
function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

/** Copies Node Buffer chunks into a plain Uint8Array for the IPC contract. */
function toPlainUint8Array(buffer: Buffer): Uint8Array {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

/** Throws the standard abort error shape before spawning or parsing. */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError();
}

/** Creates the standard AbortError shape used across Git blob reads. */
function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Requests graceful termination of a cat-file process. */
function killChild(child: GitCatFileProcess): void {
  if (child.killed) return;
  child.kill("SIGTERM");
}
