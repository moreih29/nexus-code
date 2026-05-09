/**
 * Main-process wrapper around one repository. The repository root is the Git
 * toplevel, which may be above the opened workspace when a subdirectory is open.
 */
import { StringDecoder } from "node:string_decoder";
import type {
  BranchList,
  CommitResult,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitExpandedGroupKey,
  GitStatus,
  GitStatusEntry,
  LogChunk,
  LogComplete,
  LogEntry,
  PullResult,
  PushResult,
} from "../../shared/types/git";
import type { GitBinary } from "./git-binary";
import { GitError } from "./git-error";
import { type RunGitResult, runGit, streamGit } from "./git-process";
import { parseV2Porcelain } from "./porcelain-v2";

const DIFF_CHUNK_MAX_BYTES = 1024 * 1024;
const LOG_CHUNK_ENTRY_COUNT = 50;
const LOG_FIELD_SEPARATOR = "\x1f";
const LOG_RECORD_SEPARATOR = "\x1e";
const LOG_FORMAT = `${["%H", "%h", "%P", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f")}%x1e`;

export interface GitLogArgs {
  readonly ref?: string;
  readonly skip?: number;
  readonly limit?: number;
}

interface QueuedOperation {
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

interface DiscardOptions {
  readonly source?: GitExpandedGroupKey;
}

interface DiscardPathsets {
  readonly restoreAllPaths: string[];
  readonly restoreWorktreePaths: string[];
  readonly resetIndexPaths: string[];
  readonly resetThenCleanPaths: string[];
  readonly cleanPaths: string[];
}

/**
 * Serializes all Git subprocesses for one repository and exposes typed SCM ops.
 */
export class GitRepository {
  readonly workspaceId: string;
  readonly topLevel: string;
  readonly gitDir: string;
  readonly gitVersion: string | null;

  private readonly binPath: string;
  private readonly operationControllers = new Set<AbortController>();
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(workspaceId: string, topLevel: string, gitDir: string, bin: GitBinary | string) {
    this.workspaceId = workspaceId;
    this.topLevel = topLevel;
    this.gitDir = gitDir;
    this.binPath = typeof bin === "string" ? bin : bin.path;
    this.gitVersion = typeof bin === "string" ? null : bin.version;
  }

  /**
   * Reads porcelain v2 status and groups entries for the Source Control panel.
   */
  status(signal?: AbortSignal): Promise<GitStatus> {
    return this.queue((queuedSignal) => this.readStatus(queuedSignal), signal);
  }

  /**
   * Stages one or more repository-relative paths.
   */
  stage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.run(["add", "--", ...relPaths], queuedSignal);
    }, signal);
  }

  /**
   * Removes one or more paths from the index while preserving working files.
   */
  unstage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.run(["reset", "-q", "--", ...relPaths], queuedSignal);
    }, signal);
  }

  /**
   * Discards tracked changes and deletes untracked paths selected by status rows.
   */
  discard(
    relPaths: readonly string[],
    options: DiscardOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;

      const status = await this.readStatus(queuedSignal);
      const pathsets = collectDiscardPathsets(status, relPaths, options);

      if (pathsets.resetIndexPaths.length > 0) {
        await this.run(["reset", "-q", "--", ...pathsets.resetIndexPaths], queuedSignal);
      }
      if (pathsets.restoreWorktreePaths.length > 0) {
        await this.run(
          ["restore", "--worktree", "--", ...pathsets.restoreWorktreePaths],
          queuedSignal,
        );
      }
      if (pathsets.restoreAllPaths.length > 0) {
        await this.run(
          ["restore", "--staged", "--worktree", "--", ...pathsets.restoreAllPaths],
          queuedSignal,
        );
      }
      if (pathsets.resetThenCleanPaths.length > 0) {
        await this.run(["reset", "-q", "--", ...pathsets.resetThenCleanPaths], queuedSignal);
        await this.run(["clean", "-f", "--", ...pathsets.resetThenCleanPaths], queuedSignal);
      }
      if (pathsets.cleanPaths.length > 0) {
        await this.run(["clean", "-f", "--", ...pathsets.cleanPaths], queuedSignal);
      }
    }, signal);
  }

  /**
   * Creates a commit and returns the new HEAD SHA.
   */
  commit(
    message: string,
    options: { readonly amend?: boolean; readonly signoff?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      if (message.trim().length === 0) {
        throw new GitError("unknown", "Commit message is required");
      }

      const args = ["commit", "-m", message];
      if (options.amend) args.push("--amend");
      if (options.signoff) args.push("--signoff");
      await this.run(args, queuedSignal);

      const { stdout } = await this.run(["rev-parse", "HEAD"], queuedSignal);
      return { sha: stdout.trim() };
    }, signal);
  }

  /**
   * Checks out an existing branch, tag, or commit-ish reference.
   */
  checkout(ref: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (ref.trim().length === 0) throw new GitError("unknown", "Checkout ref is required");
      await this.run(["checkout", ref], queuedSignal);
    }, signal);
  }

  /**
   * Creates a branch, optionally checking it out immediately.
   */
  createBranch(name: string, checkout = false, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (name.trim().length === 0) throw new GitError("unknown", "Branch name is required");
      await this.run(checkout ? ["checkout", "-b", name] : ["branch", name], queuedSignal);
    }, signal);
  }

  /**
   * Lists local and remote branch names with current branch metadata.
   */
  listBranches(signal?: AbortSignal): Promise<BranchList> {
    return this.queue(async (queuedSignal) => {
      const status = await this.readStatus(queuedSignal);
      const local = await this.run(["branch", "--format=%(refname:short)", "--list"], queuedSignal);
      const remote = await this.run(
        ["branch", "--format=%(refname:short)", "--remotes"],
        queuedSignal,
      );

      return {
        current: status.branch,
        local: parseBranchLines(local.stdout),
        remote: parseBranchLines(remote.stdout).filter((name) => !name.endsWith("/HEAD")),
      };
    }, signal);
  }

  /**
   * Fetches from the configured remote or from a named remote.
   */
  fetch(remote?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const args = remote && remote.trim().length > 0 ? ["fetch", remote] : ["fetch"];
      await this.run(args, queuedSignal);
    }, signal);
  }

  /**
   * Pulls from the current upstream and summarizes the successful result.
   */
  pull(signal?: AbortSignal): Promise<PullResult> {
    return this.queue(async (queuedSignal) => {
      const result = await this.run(["pull", "--no-edit"], queuedSignal);
      return parsePullResult(result);
    }, signal);
  }

  /**
   * Pushes the current branch, using force-with-lease for explicit force pushes.
   */
  push(force = false, signal?: AbortSignal): Promise<PushResult> {
    return this.queue(async (queuedSignal) => {
      const result = await this.run(
        force ? ["push", "--force-with-lease"] : ["push"],
        queuedSignal,
      );
      return parsePushResult(result);
    }, signal);
  }

  /**
   * Saves current changes on the stash stack.
   */
  stash(message?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const args = ["stash", "push"];
      if (message && message.trim().length > 0) args.push("-m", message);
      await this.run(args, queuedSignal);
    }, signal);
  }

  /**
   * Applies and drops the most recent stash entry.
   */
  stashPop(signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["stash", "pop"], queuedSignal);
    }, signal);
  }

  /**
   * Reads a blob from the index or a Git ref. Working-tree reads use fs handlers.
   */
  getFileContent(ref: string, relPath: string, signal?: AbortSignal): Promise<string> {
    return this.queue(async (queuedSignal) => {
      if (ref === "WORKING") {
        throw new GitError("unknown", "Working-tree content is read through the filesystem");
      }
      if (relPath.trim().length === 0) throw new GitError("unknown", "File path is required");
      const objectSpec = ref === "INDEX" ? `:${relPath}` : `${ref}:${relPath}`;
      const { stdout } = await this.run(["show", "--no-ext-diff", objectSpec], queuedSignal);
      return stdout;
    }, signal);
  }

  /**
   * Streams diff output in bounded chunks so IPC can apply back-pressure.
   */
  async *diff(
    spec: DiffSpec,
    signal?: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    return yield* this.queueStream((queuedSignal) => this.streamDiff(spec, queuedSignal), signal);
  }

  /**
   * Streams commit log entries parsed into stable chunk objects.
   */
  async *log(args: GitLogArgs = {}, signal?: AbortSignal): AsyncGenerator<LogChunk, LogComplete> {
    return yield* this.queueStream((queuedSignal) => this.streamLog(args, queuedSignal), signal);
  }

  /**
   * Convenience hook used by registries and coalescers before broadcasting.
   */
  refreshStatus(signal?: AbortSignal): Promise<GitStatus> {
    return this.status(signal);
  }

  /**
   * Aborts in-flight and queued operations; later calls reject with AbortError.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.operationControllers) {
      controller.abort();
    }
  }

  /**
   * Adds one operation to the repository's serial chain.
   */
  private queue<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const operation = this.createQueuedOperation(signal);
    const task = this.queueTail.then(async () => {
      throwIfAborted(operation.controller.signal);
      return run(operation.controller.signal);
    });

    this.queueTail = task.then(noop, noop);

    return task.finally(operation.cleanup);
  }

  /**
   * Adds one streaming operation to the serial chain and holds it until return.
   */
  private async *queueStream<T, R>(
    run: (signal: AbortSignal) => AsyncGenerator<T, R, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<T, R, unknown> {
    const operation = this.createQueuedOperation(signal);
    const previous = this.queueTail;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.queueTail = previous.then(
      () => completion,
      () => completion,
    );

    try {
      await previous;
      throwIfAborted(operation.controller.signal);
      return yield* run(operation.controller.signal);
    } finally {
      operation.cleanup();
      release();
    }
  }

  /**
   * Creates the per-operation controller that dispose() and caller signals abort.
   */
  private createQueuedOperation(signal?: AbortSignal): QueuedOperation {
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    if (this.disposed || signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    this.operationControllers.add(controller);

    return {
      controller,
      cleanup: () => {
        signal?.removeEventListener("abort", abort);
        this.operationControllers.delete(controller);
      },
    };
  }

  /**
   * Runs a buffered git command within the already-acquired queue slot.
   */
  private run(args: readonly string[], signal: AbortSignal): Promise<RunGitResult> {
    throwIfAborted(signal);
    return runGit({ bin: this.binPath, cwd: this.topLevel, args, signal });
  }

  /**
   * Parses `git status --porcelain=v2 -z -b` output for this repository.
   */
  private async readStatus(signal: AbortSignal): Promise<GitStatus> {
    const { stdout } = await this.run(
      ["status", "--porcelain=v2", "-z", "-b", "--untracked-files=all", "--renames"],
      signal,
    );
    return parseV2Porcelain(stdout);
  }

  /**
   * Converts git diff stdout into fixed-size text chunks.
   */
  private async *streamDiff(
    spec: DiffSpec,
    signal: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    const args = buildDiffArgs(spec);
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

    for await (const chunk of streamGit({ bin: this.binPath, cwd: this.topLevel, args, signal })) {
      totalBytes += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const remainingCapacity = DIFF_CHUNK_MAX_BYTES - bufferedBytes;
        const take = Math.min(remainingCapacity, chunk.byteLength - offset);
        buffers.push(chunk.subarray(offset, offset + take));
        bufferedBytes += take;
        offset += take;

        if (bufferedBytes >= DIFF_CHUNK_MAX_BYTES) {
          const flushed = flush();
          if (flushed) yield flushed;
        }
      }
    }

    const flushed = flush();
    if (flushed) yield flushed;
    const trailing = decoder.end();
    if (trailing.length > 0) yield { text: trailing };

    return { bytes: totalBytes, truncated: false };
  }

  /**
   * Converts git log stdout into typed log-entry chunks.
   */
  private async *streamLog(
    logArgs: GitLogArgs,
    signal: AbortSignal,
  ): AsyncGenerator<LogChunk, LogComplete> {
    const args = buildLogArgs(logArgs);
    const decoder = new StringDecoder("utf8");
    let pendingText = "";
    let count = 0;
    let hasMore = false;
    let entries: LogEntry[] = [];
    const limit = logArgs.limit;

    const emitReadyEntries = function* (): Generator<LogChunk> {
      if (entries.length === 0) return;
      yield { entries };
      entries = [];
    };

    const handleRecord = function* (record: string): Generator<LogChunk> {
      const entry = parseLogRecord(record);
      if (!entry) return;
      if (limit !== undefined && count >= limit) {
        hasMore = true;
        return;
      }

      entries.push(entry);
      count += 1;
      if (entries.length >= LOG_CHUNK_ENTRY_COUNT) {
        yield* emitReadyEntries();
      }
    };

    for await (const chunk of streamGit({ bin: this.binPath, cwd: this.topLevel, args, signal })) {
      pendingText += decoder.write(chunk);
      const records = pendingText.split(LOG_RECORD_SEPARATOR);
      pendingText = records.pop() ?? "";
      for (const record of records) {
        yield* handleRecord(record);
      }
    }

    pendingText += decoder.end();
    if (pendingText.length > 0) {
      yield* handleRecord(pendingText);
    }
    yield* emitReadyEntries();

    return { count, hasMore };
  }
}

/**
 * Builds `git diff` arguments from the shared diff spec union.
 */
function buildDiffArgs(spec: DiffSpec): string[] {
  const args = ["diff", "--no-ext-diff"];

  if (spec.kind === "index-vs-head") {
    args.push("--cached");
  } else if (spec.kind === "wt-vs-head") {
    args.push("HEAD");
  } else if (spec.kind === "ref-vs-ref") {
    args.push(spec.leftRef, spec.rightRef);
  }

  const pathspecs = collectDiffPathspecs(spec);
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }

  return args;
}

/**
 * Returns every path needed to show a rename-aware diff.
 */
function collectDiffPathspecs(spec: DiffSpec): string[] {
  const paths = new Set<string>();
  if (spec.oldRelPath) paths.add(spec.oldRelPath);
  if (spec.relPath) paths.add(spec.relPath);
  return Array.from(paths);
}

/**
 * Builds a `git log` command that fetches one extra row when paginating.
 */
function buildLogArgs(args: GitLogArgs): string[] {
  const gitArgs = ["log", `--pretty=format:${LOG_FORMAT}`, "--date=iso-strict"];

  if (args.skip && args.skip > 0) gitArgs.push(`--skip=${args.skip}`);
  if (args.limit && args.limit > 0) gitArgs.push(`--max-count=${args.limit + 1}`);
  if (args.ref && args.ref.trim().length > 0) gitArgs.push(args.ref);

  return gitArgs;
}

/**
 * Parses one custom-formatted git log record.
 */
function parseLogRecord(record: string): LogEntry | null {
  const normalized = record.startsWith("\n") ? record.slice(1) : record;
  if (normalized.trim().length === 0) return null;

  const fields = normalized.split(LOG_FIELD_SEPARATOR);
  if (fields.length < 7) return null;

  const [sha, shortSha, parents, authorName, authorEmail, authoredAt, subject, ...bodyParts] =
    fields;
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
  };
}

/**
 * Converts branch command stdout into non-empty branch names.
 */
function parseBranchLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Summarizes successful `git pull` output for renderer banners.
 */
function parsePullResult(result: RunGitResult): PullResult {
  const summary = summarizeGitOutput(result);
  const stats = parseDiffStat(summary);
  return {
    alreadyUpToDate: /already up[ -]to[ -]date/i.test(summary),
    fastForward: /fast-forward/i.test(summary) || undefined,
    ...stats,
    summary: summary || undefined,
  };
}

/**
 * Summarizes successful `git push` output for renderer banners.
 */
function parsePushResult(result: RunGitResult): PushResult {
  const summary = summarizeGitOutput(result);
  return {
    pushed: !/everything up[ -]to[ -]date/i.test(summary),
    summary: summary || undefined,
  };
}

/**
 * Joins stdout and stderr because Git reports network progress on stderr.
 */
function summarizeGitOutput(result: RunGitResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * Extracts the common `N files changed, X insertions, Y deletions` summary.
 */
function parseDiffStat(
  summary: string,
): Pick<PullResult, "filesChanged" | "insertions" | "deletions"> {
  const stats: Pick<PullResult, "filesChanged" | "insertions" | "deletions"> = {};
  const files = /(\d+) files? changed/.exec(summary);
  const insertions = /(\d+) insertions?\(\+\)/.exec(summary);
  const deletions = /(\d+) deletions?\(-\)/.exec(summary);

  if (files) stats.filesChanged = Number(files[1]);
  if (insertions) stats.insertions = Number(insertions[1]);
  if (deletions) stats.deletions = Number(deletions[1]);
  return stats;
}

/**
 * Computes the git commands needed to discard selected status entries.
 */
function collectDiscardPathsets(
  status: GitStatus,
  relPaths: readonly string[],
  options: DiscardOptions,
): DiscardPathsets {
  const selected = new Set(relPaths);
  const restoreAllPaths = new Set<string>();
  const restoreWorktreePaths = new Set<string>();
  const resetIndexPaths = new Set<string>();
  const resetThenCleanPaths = new Set<string>();
  const cleanPaths = new Set<string>();
  const source = options.source;

  if (!source || source === "staged") {
    for (const entry of status.staged) {
      if (!entryIsSelected(entry, selected)) continue;
      const stagedCode = entry.xy[0];

      if (source === "staged") {
        resetIndexPaths.add(entry.relPath);
        if (entry.oldRelPath) resetIndexPaths.add(entry.oldRelPath);
        continue;
      }

      if (stagedCode === "A" || stagedCode === "C") {
        resetThenCleanPaths.add(entry.relPath);
        continue;
      }
      restoreAllPaths.add(entry.relPath);
      if (stagedCode === "R" && entry.oldRelPath) restoreAllPaths.add(entry.oldRelPath);
    }
  }

  if (!source || source === "working") {
    for (const entry of status.working) {
      if (!entryIsSelected(entry, selected)) continue;
      if (source === "working") {
        restoreWorktreePaths.add(entry.relPath);
        if (entry.oldRelPath) restoreWorktreePaths.add(entry.oldRelPath);
        continue;
      }

      restoreAllPaths.add(entry.relPath);
      if (entry.xy[0] === "R" && entry.oldRelPath) restoreAllPaths.add(entry.oldRelPath);
    }
  }

  if (!source || source === "merge") {
    for (const entry of status.merge) {
      if (!entryIsSelected(entry, selected)) continue;
      restoreAllPaths.add(entry.relPath);
    }
  }

  if (!source || source === "untracked") {
    for (const entry of status.untracked) {
      if (selected.has(entry.relPath)) cleanPaths.add(entry.relPath);
    }
  }

  return {
    restoreAllPaths: Array.from(restoreAllPaths),
    restoreWorktreePaths: Array.from(restoreWorktreePaths),
    resetIndexPaths: Array.from(resetIndexPaths),
    resetThenCleanPaths: Array.from(resetThenCleanPaths),
    cleanPaths: Array.from(cleanPaths).filter((path) => !resetThenCleanPaths.has(path)),
  };
}

/**
 * Matches a row by new or old path so rename rows can be selected once.
 */
function entryIsSelected(entry: GitStatusEntry, selected: Set<string>): boolean {
  return selected.has(entry.relPath) || (entry.oldRelPath ? selected.has(entry.oldRelPath) : false);
}

/**
 * Throws the standard abort error shape before spawning or streaming Git.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw createAbortError();
}

/**
 * Creates the standard AbortError shape used across queued repository ops.
 */
function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Keeps queue tails non-rejecting without allocating inline callbacks repeatedly.
 */
function noop(): void {}
