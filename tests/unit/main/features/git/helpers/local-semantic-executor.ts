import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  GitBlobOptions,
  GitBranchDeleteOptions,
  GitCommitDetailOptions,
  GitDiffOptions,
  GitExecutor,
  GitLogOptions,
  GitProcessOptions,
  GitPullOptions,
  GitPushOptions,
  GitStatusOptions,
  RunGitOptions,
  RunGitResult,
} from "../../../../../../src/main/features/git/bridge/types";
import { GitError } from "../../../../../../src/main/features/git/domain/error";
import {
  type GitMetadataReader,
  GitRepository,
} from "../../../../../../src/main/features/git/domain/repository";
import {
  buildDiffArgs,
  readFetchHeadMtime,
} from "../../../../../../src/main/features/git/domain/repository-helpers";
import {
  type CommitDetail,
  type CommitFileChange,
  type DiffChunk,
  type DiffComplete,
  type GitBlobChunk,
  type GitBlobComplete,
  type GitConflictType,
  type GitOperationState,
  type GitStatus,
  type GitStatusEntry,
  LOG_CHUNK_ENTRY_COUNT,
  type LogChunk,
  type LogComplete,
  type LogEntry,
  type LogEntryRef,
  type PullResult,
  type PushResult,
} from "../../../../../../src/shared/git/types";

const LOG_FIELD_SEPARATOR = "\x1f";
const LOG_RECORD_SEPARATOR = "\x1e";
const LOG_FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%s", "%b", "%D"];
const LOG_FORMAT = `${LOG_FIELDS.join("%x1f")}%x1e`;
const LOG_SOURCE_FORMAT = `${["%S", ...LOG_FIELDS].join("%x1f")}%x1e`;
const DETAIL_FIELD_SEPARATOR = "\x00";
const DETAIL_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%cI%x00%s%x00%B%x00";
const TEXT_CHUNK_MAX_BYTES = 1024 * 1024;

const CONFLICT_TYPES: Record<string, GitConflictType> = {
  DD: "both-deleted",
  AU: "added-by-us",
  UD: "deleted-by-them",
  UA: "added-by-them",
  DU: "deleted-by-us",
  AA: "both-added",
  UU: "both-modified",
};

const stubMetadataReader: GitMetadataReader = {
  metadata: () => {
    throw new Error("stubMetadataReader.metadata not implemented in this test");
  },
  addToGitignore: () => {
    throw new Error("stubMetadataReader.addToGitignore not implemented in this test");
  },
};

export function newLocalGitRepository(
  workspaceId: string,
  topLevel: string,
  gitDir: string,
  bin: string,
): GitRepository {
  return new GitRepository(
    workspaceId,
    topLevel,
    gitDir,
    bin,
    localSemanticExecutor(bin, gitDir),
    stubMetadataReader,
  );
}

export { stubMetadataReader };

export function localSemanticExecutor(bin: string, gitDirHint?: string): GitExecutor {
  const runLocal = (options: Omit<RunGitOptions, "bin"> & { readonly bin?: string }) =>
    runLocalGit(options, bin);

  return {
    run(options: RunGitOptions): Promise<RunGitResult> {
      return runLocalGit(options, bin);
    },

    async *stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
      return yield* streamLocalGit(options, bin);
    },

    async status(options: GitStatusOptions): Promise<GitStatus> {
      const statusArgs = [
        "status",
        "--porcelain=v2",
        "-z",
        "-b",
        `--untracked-files=${options.untracked ?? "all"}`,
        options.renames === false ? "--no-renames" : "--renames",
      ];
      if (options.ignored) statusArgs.push("--ignored");

      const [{ stdout }, remotes, stashCount, tagCount] = await Promise.all([
        runLocal({ cwd: options.cwd, args: statusArgs, signal: options.signal }),
        readNonemptyLines(runLocal, options.cwd, ["remote"], options.signal),
        countNonemptyLines(runLocal, options.cwd, ["stash", "list", "--format=%H"], options.signal),
        countNonemptyLines(runLocal, options.cwd, ["tag", "--list"], options.signal),
      ]);
      const status = parseLocalPorcelainStatus(stdout);
      const gitDir = await resolveGitDir(runLocal, options.cwd, gitDirHint, options.signal);
      const [operationState, lastFetchedAt] = await Promise.all([
        readLocalGitOperationState(gitDir, status.merge.length),
        readFetchHeadMtime(gitDir),
      ]);
      return {
        ...status,
        capabilities: {
          hasHEAD: status.branch !== null && !status.branch.isUnborn,
          remotes,
          stashCount,
          tagCount,
        },
        operationState,
        lastFetchedAt,
      };
    },

    async *log(options: GitLogOptions): AsyncGenerator<LogChunk, LogComplete, unknown> {
      return yield* streamLocalLog(bin, options);
    },

    async *diff(options: GitDiffOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
      return yield* streamLocalText(
        streamLocalGit({
          bin,
          cwd: options.cwd,
          args: buildDiffArgs(options.spec),
          signal: options.signal,
        }),
        options.signal,
        options.maxChunkBytes,
      );
    },

    async *blob(options: GitBlobOptions): AsyncGenerator<GitBlobChunk, GitBlobComplete, unknown> {
      const objectSpec =
        options.ref === "INDEX" ? `:${options.relPath}` : `${options.ref}:${options.relPath}`;
      let bytes = 0;
      for await (const chunk of streamLocalGit({
        bin,
        cwd: options.cwd,
        args: ["show", "--no-ext-diff", objectSpec],
        signal: options.signal,
      })) {
        bytes += chunk.byteLength;
        yield { chunk: toPlainUint8Array(chunk) };
      }
      return { bytes };
    },

    async commitDetail(options: GitCommitDetailOptions): Promise<CommitDetail> {
      const { stdout } = await runLocal({
        cwd: options.cwd,
        args: buildCommitDetailArgs(options.sha),
        signal: options.signal,
      });
      return parseCommitDetailOutput(stdout);
    },

    async pull(options: GitPullOptions): Promise<PullResult> {
      const args = options.args ? [...options.args] : ["pull"];
      const { stdout } = await runLocal({ cwd: options.cwd, args, signal: options.signal });
      return {
        alreadyUpToDate: stdout.includes("Already up to date"),
      };
    },

    async push(options: GitPushOptions): Promise<PushResult> {
      const args = options.args
        ? [...options.args]
        : options.force
          ? ["push", "--force-with-lease"]
          : ["push"];
      await runLocal({ cwd: options.cwd, args, signal: options.signal });
      return { pushed: true };
    },

    async branchDelete(options: GitBranchDeleteOptions): Promise<void> {
      const args = ["branch", options.force ? "-D" : "-d", "--", options.name];
      await runLocal({ cwd: options.cwd, args, signal: options.signal });
    },
  };
}

type RunLocal = (
  options: Omit<RunGitOptions, "bin"> & { readonly bin?: string },
) => Promise<RunGitResult>;

function runLocalGit(
  options: Omit<RunGitOptions, "bin"> & { readonly bin?: string },
  defaultBin: string,
): Promise<RunGitResult> {
  const bin = options.bin ?? defaultBin;
  const stdoutCapBytes = options.stdoutCapBytes ?? 10 * 1024 * 1024;
  throwIfAborted(options.signal);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...options.args], {
      cwd: options.cwd,
      env: localGitEnv(options.env, options.interactive ?? false),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let pendingFailure: Error | null = null;

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      pendingFailure = createAbortError();
      child.kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutCapBytes && !pendingFailure) {
        pendingFailure = new GitError("output-too-large", "Git output exceeded test read limit", {
          argv: options.args,
        });
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      pendingFailure = error;
    });
    child.on("close", (code, signal) => {
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (pendingFailure) {
        reject(pendingFailure);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(localGitExitError(options.args, stdout, stderr, code, signal));
    });
  });
}

async function* streamLocalGit(
  options: Omit<GitProcessOptions, "bin"> & { readonly bin?: string },
  defaultBin: string,
): AsyncGenerator<Buffer, void, unknown> {
  const bin = options.bin ?? defaultBin;
  throwIfAborted(options.signal);

  const child = spawn(bin, [...options.args], {
    cwd: options.cwd,
    env: localGitEnv(options.env, options.interactive ?? false),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  let pendingFailure: Error | null = null;

  const cleanup = (): void => {
    options.signal?.removeEventListener("abort", abort);
  };
  const abort = (): void => {
    pendingFailure = createAbortError();
    child.kill();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  child.on("error", (error) => {
    pendingFailure = error;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });

  try {
    for await (const chunk of child.stdout) {
      throwIfAborted(options.signal);
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    const result = await closed;
    if (pendingFailure) throw pendingFailure;
    if (result.code !== 0) {
      throw localGitExitError(
        options.args,
        "",
        Buffer.concat(stderrChunks).toString("utf8"),
        result.code,
        result.signal,
      );
    }
  } finally {
    cleanup();
    if (!child.killed) child.kill();
  }
}

function localGitEnv(env: NodeJS.ProcessEnv | undefined, interactive: boolean): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_FLUSH: "1",
  };
  if (!interactive) {
    merged.GIT_ASKPASS = env?.GIT_ASKPASS ?? "echo";
    merged.SSH_ASKPASS_REQUIRE = env?.SSH_ASKPASS_REQUIRE ?? "force";
    merged.SSH_ASKPASS = env?.SSH_ASKPASS ?? "echo";
    delete merged.GIT_EDITOR;
    delete merged.EDITOR;
  }
  return merged;
}

function localGitExitError(
  args: readonly string[],
  stdout: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): GitError {
  return new GitError("unknown", stderr.trim() || `Git exited with code ${code ?? "null"}`, {
    argv: args,
    stdout,
    stderr,
    exitCode: code,
    signal,
  });
}

async function readNonemptyLines(
  runLocal: RunLocal,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const { stdout } = await runLocal({ cwd, args, signal });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function countNonemptyLines(
  runLocal: RunLocal,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  return (await readNonemptyLines(runLocal, cwd, args, signal)).length;
}

async function resolveGitDir(
  runLocal: RunLocal,
  cwd: string,
  gitDirHint?: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await runLocal({ cwd, args: ["rev-parse", "--absolute-git-dir"], signal });
    const gitDir = stdout.trim();
    if (gitDir.length > 0) return gitDir;
  } catch {}
  return gitDirHint ?? path.join(cwd, ".git");
}

function parseLocalPorcelainStatus(
  stdout: string,
): Pick<GitStatus, "branch" | "merge" | "staged" | "working" | "untracked"> {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const merge: GitStatusEntry[] = [];
  const staged: GitStatusEntry[] = [];
  const working: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let branchHead: string | null = null;
  let branchOid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record.startsWith("# ")) {
      const header = record.slice(2);
      if (header.startsWith("branch.head ")) branchHead = header.slice(12).trim();
      if (header.startsWith("branch.oid ")) branchOid = header.slice(11).trim();
      if (header.startsWith("branch.upstream ")) upstream = header.slice(16).trim() || null;
      if (header.startsWith("branch.ab ")) {
        const match = /\+(\d+)\s+-(\d+)/.exec(header.slice(10));
        ahead = Number(match?.[1] ?? 0);
        behind = Number(match?.[2] ?? 0);
      }
      continue;
    }

    if (record.startsWith("? ")) {
      untracked.push({ relPath: record.slice(2), xy: "??", conflictType: null });
      continue;
    }

    if (record.startsWith("1 ")) {
      addTrackedStatus(parseOrdinaryRecord(record), { merge, staged, working });
      continue;
    }

    if (record.startsWith("2 ")) {
      const entry = parseRenameRecord(record, records[i + 1]);
      i += 1;
      addTrackedStatus(entry, { merge, staged, working });
      continue;
    }

    if (record.startsWith("u ")) {
      merge.push(parseUnmergedRecord(record));
    }
  }

  const isUnborn = branchOid === "(initial)";
  const current = branchHead && branchHead !== "(detached)" ? branchHead : null;

  return {
    merge,
    staged,
    working,
    untracked,
    branch: current
      ? {
          current,
          upstream,
          ahead,
          behind,
          isUnborn,
        }
      : null,
  };
}

function parseOrdinaryRecord(record: string): GitStatusEntry {
  const fields = splitGitFields(record, 9);
  return statusEntry(fields[1] ?? "..", fields[8] ?? "");
}

function parseRenameRecord(record: string, oldRelPath: string | undefined): GitStatusEntry {
  const fields = splitGitFields(record, 10);
  return statusEntry(fields[1] ?? "..", fields[9] ?? "", oldRelPath);
}

function parseUnmergedRecord(record: string): GitStatusEntry {
  const fields = splitGitFields(record, 11);
  const xy = fields[1] ?? "UU";
  return statusEntry(xy, fields[10] ?? "", undefined, CONFLICT_TYPES[xy] ?? "both-modified");
}

function addTrackedStatus(
  entry: GitStatusEntry,
  groups: Pick<GitStatus, "merge" | "staged" | "working">,
): void {
  const conflictType = CONFLICT_TYPES[entry.xy];
  if (conflictType) {
    groups.merge.push({ ...entry, conflictType });
    return;
  }
  if (entry.xy[0] !== ".") groups.staged.push(entry);
  if (entry.xy[1] !== ".") groups.working.push(entry);
}

function statusEntry(
  xy: string,
  relPath: string,
  oldRelPath?: string,
  conflictType: GitConflictType = null,
): GitStatusEntry {
  return oldRelPath ? { relPath, oldRelPath, xy, conflictType } : { relPath, xy, conflictType };
}

function splitGitFields(record: string, fieldCount: number): string[] {
  const fields: string[] = [];
  let offset = 0;
  for (let i = 1; i < fieldCount; i += 1) {
    const next = record.indexOf(" ", offset);
    if (next === -1) break;
    fields.push(record.slice(offset, next));
    offset = next + 1;
  }
  fields.push(record.slice(offset));
  return fields;
}

async function* streamLocalLog(
  bin: string,
  logArgs: GitLogOptions,
): AsyncGenerator<LogChunk, LogComplete, unknown> {
  const args = buildLocalLogArgs(logArgs);
  const scope = logArgs.scope ?? "ref";
  const hasSource = scope !== "ref";
  const cursorSha = logArgs.afterSha?.trim() || undefined;
  const decoder = new StringDecoder("utf8");
  let pendingText = "";
  let count = 0;
  let hasMore = false;
  let cursorReached = !cursorSha;
  let stopReading = false;
  let entries: LogEntry[] = [];
  const limit = logArgs.limit;

  const emitReadyEntries = function* (): Generator<LogChunk> {
    if (entries.length === 0) return;
    yield { entries };
    entries = [];
  };

  const handleRecord = function* (record: string): Generator<LogChunk> {
    const entry = parseLogRecord(record, { hasSource });
    if (!entry) return;

    if (!cursorReached) {
      cursorReached = entry.sha === cursorSha;
      return;
    }

    if (limit !== undefined && count >= limit) {
      hasMore = true;
      stopReading = true;
      return;
    }

    entries.push(entry);
    count += 1;
    if (entries.length >= LOG_CHUNK_ENTRY_COUNT) {
      yield* emitReadyEntries();
    }
  };

  for await (const chunk of streamLocalGit({
    bin,
    cwd: logArgs.cwd,
    args,
    signal: logArgs.signal,
  })) {
    pendingText += decoder.write(chunk);
    const records = pendingText.split(LOG_RECORD_SEPARATOR);
    pendingText = records.pop() ?? "";
    for (const record of records) {
      yield* handleRecord(record);
      if (stopReading) break;
    }
    if (stopReading) break;
  }

  pendingText += stopReading ? "" : decoder.end();
  if (!stopReading && pendingText.length > 0) {
    yield* handleRecord(pendingText);
  }
  yield* emitReadyEntries();

  return { count, hasMore };
}

function buildLocalLogArgs(args: GitLogOptions): string[] {
  const scope = args.scope ?? "ref";
  if (scope !== "ref" && args.skip !== undefined) {
    throw new Error("`skip` is only supported for ref-scoped git logs.");
  }

  const afterSha = args.afterSha?.trim();
  const usesStreamCursorSeek = afterSha !== undefined && afterSha.length > 0;
  const format = scope === "ref" ? LOG_FORMAT : LOG_SOURCE_FORMAT;
  const gitArgs = ["log", `--pretty=format:${format}`, "--date=iso-strict", "--date-order"];

  if (args.grep && args.grep.trim().length > 0) gitArgs.push(`--grep=${args.grep.trim()}`);
  if (scope === "ref" && args.skip && args.skip > 0) gitArgs.push(`--skip=${args.skip}`);
  if (args.limit && args.limit > 0 && !usesStreamCursorSeek) {
    gitArgs.push(`--max-count=${args.limit + 1}`);
  }
  if (scope === "all") gitArgs.push("--source", "--all");
  if (scope === "branches") gitArgs.push("--source", "--branches");
  if (scope === "ref" && args.ref && args.ref.trim().length > 0) {
    gitArgs.push(args.ref);
  }

  return gitArgs;
}

function parseLogRecord(
  record: string,
  options: { readonly hasSource?: boolean } = {},
): LogEntry | null {
  const normalized = record.startsWith("\n") ? record.slice(1) : record;
  if (normalized.trim().length === 0) return null;

  const fields = normalized.split(LOG_FIELD_SEPARATOR);
  const offset = options.hasSource ? 1 : 0;
  if (fields.length < offset + LOG_FIELDS.length) return null;

  const sha = fields[offset];
  const shortSha = fields[offset + 1];
  const parents = fields[offset + 2];
  const authorName = fields[offset + 3];
  const authorEmail = fields[offset + 4];
  const authoredAt = fields[offset + 5];
  const subject = fields[offset + 6];
  const decorations = fields.at(-1) ?? "";
  const bodyParts = fields.slice(offset + 7, -1);
  if (!sha) return null;
  const body = bodyParts.join(LOG_FIELD_SEPARATOR).trim();

  return {
    sha,
    shortSha: shortSha || undefined,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    authorName: authorName ?? "",
    authorEmail: authorEmail || undefined,
    authoredAt: authoredAt ?? "",
    subject: subject ?? "",
    body: body.length > 0 ? body : undefined,
    refs: parseLogDecorations(decorations),
  };
}

function parseLogDecorations(decorations: string): LogEntryRef[] {
  const refs = new Map<string, LogEntryRef>();

  const pushRef = (ref: LogEntryRef | null) => {
    if (!ref) return;
    const key = `${ref.kind}:${ref.name}`;
    const existing = refs.get(key);
    refs.set(key, existing ? { ...existing, isHead: existing.isHead || ref.isHead } : ref);
  };

  for (const rawPart of decorations.split(/,\s*/)) {
    const part = rawPart.trim();
    if (part.length === 0) continue;

    const arrowIndex = part.indexOf(" -> ");
    if (arrowIndex >= 0) {
      const source = part.slice(0, arrowIndex).trim();
      const target = part.slice(arrowIndex + 4).trim();
      const sourceRef = parseDecorationRef(source, false);
      pushRef(sourceRef);
      pushRef(parseDecorationRef(target, sourceRef?.kind === "head"));
      continue;
    }

    pushRef(parseDecorationRef(part, false));
  }

  return Array.from(refs.values());
}

function parseDecorationRef(rawName: string, isHeadTarget: boolean): LogEntryRef | null {
  if (rawName.length === 0) return null;
  if (rawName === "HEAD") return { name: "HEAD", kind: "head", isHead: true };

  if (rawName.startsWith("tag: ")) {
    return {
      name: normalizeDecoratedRefName(rawName.slice(5), "tag"),
      kind: "tag",
      isHead: false,
    };
  }

  const name = normalizeDecoratedRefName(rawName);
  if (name.length === 0) return null;
  if (name === "HEAD") return { name: "HEAD", kind: "head", isHead: true };

  return {
    name,
    kind: isDecoratedRemoteRef(rawName, name) ? "remote" : "branch",
    isHead: isHeadTarget,
  };
}

function normalizeDecoratedRefName(name: string, kind?: LogEntryRef["kind"]): string {
  const trimmed = name.trim();
  if (kind === "tag" && trimmed.startsWith("refs/tags/")) return trimmed.slice(10);
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice(11);
  if (trimmed.startsWith("refs/remotes/")) return trimmed.slice(13);
  if (trimmed.startsWith("refs/tags/")) return trimmed.slice(10);
  return trimmed;
}

function isDecoratedRemoteRef(rawName: string, normalizedName: string): boolean {
  if (rawName.startsWith("refs/remotes/")) return true;
  const firstSegment = normalizedName.split("/", 1)[0];
  return firstSegment === "origin" || firstSegment === "upstream";
}

function buildCommitDetailArgs(sha: string): string[] {
  const trimmed = sha.trim();
  if (trimmed.length === 0) throw new Error("Commit SHA is required.");
  return [
    "show",
    "--no-ext-diff",
    "--find-renames",
    "--name-status",
    "-z",
    "--first-parent",
    `--format=${DETAIL_FORMAT}`,
    trimmed,
  ];
}

function parseCommitDetailOutput(stdout: string): CommitDetail {
  const fields = stdout.split(DETAIL_FIELD_SEPARATOR);
  const [sha, parentsRaw, author, authorEmail, committerTs, subject, messageRaw] = fields;
  if (!sha) throw new Error("Could not parse commit detail SHA.");

  const message = trimTrailingNewlines(messageRaw ?? "");
  const fileTokens = fields.slice(7).filter((field) => field.length > 0);
  return {
    sha,
    parents: splitParents(parentsRaw),
    subject: subject ?? firstMessageLine(message),
    author: author ?? "",
    authorEmail: authorEmail ?? "",
    committerTs: committerTs ?? "",
    message,
    body: extractBody(message, subject ?? ""),
    files: parseNameStatusTokens(fileTokens),
  };
}

function parseNameStatusTokens(tokens: readonly string[]): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = normalizeNameStatusToken(tokens[i++]);
    if (!status) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = normalizeNameStatusToken(tokens[i++]);
      const nextPath = normalizeNameStatusToken(tokens[i++]);
      if (!oldPath || !nextPath) break;
      files.push({ status, oldPath, path: nextPath });
      continue;
    }

    const nextPath = normalizeNameStatusToken(tokens[i++]);
    if (!nextPath) break;
    files.push({ status, path: nextPath });
  }
  return files;
}

function normalizeNameStatusToken(value: string | undefined): string {
  return (value ?? "").replace(/^(?:\r?\n)+/u, "");
}

function extractBody(message: string, subject: string): string {
  if (message.length === 0) return "";
  const lines = message.split(/\r?\n/);
  if (lines[0] === subject) {
    if (lines[1] === "") return lines.slice(2).join("\n").trim();
    return lines.slice(1).join("\n").trim();
  }
  return lines.slice(1).join("\n").trim();
}

function splitParents(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(" ")
    .map((parent) => parent.trim())
    .filter((parent) => parent.length > 0);
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/(?:\r?\n)+$/u, "");
}

function firstMessageLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? "";
}

async function* streamLocalText(
  chunks: AsyncIterable<Buffer>,
  signal?: AbortSignal,
  maxChunkBytes = TEXT_CHUNK_MAX_BYTES,
): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
  const decoder = new StringDecoder("utf8");
  const buffers: Buffer[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;

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
      const take = Math.min(maxChunkBytes - bufferedBytes, chunk.byteLength - offset);
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

function toPlainUint8Array(buffer: Buffer): Uint8Array {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function readLocalGitOperationState(
  gitDir: string,
  conflictCount: number,
): Promise<GitOperationState> {
  const readTrimmed = async (absPath: string): Promise<string | null> => {
    try {
      const value = (await fs.readFile(absPath, "utf8")).trim();
      return value.length > 0 ? value : null;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "ENOENT"
      )
        return null;
      throw error;
    }
  };
  const pathExists = async (absPath: string): Promise<boolean> => {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  };
  const readProgressInt = async (absPath: string): Promise<number> => {
    const text = await readTrimmed(absPath);
    if (text === null) return 0;
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const mergeHead = await readTrimmed(path.join(gitDir, "MERGE_HEAD"));
  if (mergeHead !== null) {
    return { kind: "merge", headRef: null, mergeRef: mergeHead, conflictCount };
  }

  const rebaseMergeDir = path.join(gitDir, "rebase-merge");
  if (await pathExists(rebaseMergeDir)) {
    const isInteractive = await pathExists(path.join(rebaseMergeDir, "interactive"));
    const doneCount = await readProgressInt(path.join(rebaseMergeDir, "msgnum"));
    const totalCount = await readProgressInt(path.join(rebaseMergeDir, "end"));
    return {
      kind: "rebase",
      variant: isInteractive ? "interactive" : "merge",
      headRef: null,
      ontoRef: null,
      doneCount,
      totalCount,
      conflictCount,
    };
  }

  const rebaseApplyDir = path.join(gitDir, "rebase-apply");
  if (await pathExists(rebaseApplyDir)) {
    const doneCount = await readProgressInt(path.join(rebaseApplyDir, "next"));
    const totalCount = await readProgressInt(path.join(rebaseApplyDir, "last"));
    return {
      kind: "rebase",
      variant: "apply",
      headRef: null,
      ontoRef: null,
      doneCount,
      totalCount,
      conflictCount,
    };
  }

  const cherryPickHead = await readTrimmed(path.join(gitDir, "CHERRY_PICK_HEAD"));
  if (cherryPickHead !== null) {
    return { kind: "cherry-pick", sourceSha: cherryPickHead, conflictCount };
  }

  const revertHead = await readTrimmed(path.join(gitDir, "REVERT_HEAD"));
  if (revertHead !== null) {
    return { kind: "revert", sourceSha: revertHead, conflictCount };
  }

  return { kind: "none" };
}
