/**
 * Git clone primitive.
 *
 * Clone is the queue exception for this cycle: the repository has not been
 * registered as a workspace yet, so there is no GitRepository instance or
 * per-repo serial queue to enter. This module still keeps clone isolated from
 * IPC so validation, progress parsing, auth helper env, and cancel cleanup are
 * tested as a backend unit.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  GitCloneEvent,
  GitCloneStreamProgressEvent,
  GitCloneStreamResultEvent,
} from "../../shared/types/git";
import { GitCloneProgressParser } from "./git-clone-progress";
import { GitError, gitErrorFromExit, gitMissingError, unknownGitError } from "./git-error";
import { buildHelperEnv } from "./helpers-launcher";

const CLONE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const ABORT_KILL_GRACE_MS = 1_000;

type GitCloneChild = ChildProcessByStdio<null, Readable, Readable>;

export interface RunCloneOptions {
  readonly bin: string;
  readonly url: string;
  /** Absolute parent directory that will receive the cloned folder. */
  readonly destination: string;
  readonly name?: string;
  readonly branch?: string;
  readonly recurseSubmodules?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

interface PreparedClone {
  readonly url: string;
  readonly parentDir: string;
  readonly name: string;
  readonly absPath: string;
  readonly branch?: string;
  readonly recurseSubmodules: boolean;
}

/**
 * Runs `git clone`, forwarding normalized clone events to `onEvent`.
 *
 * Terminal events (`complete`/`cancelled`) are both emitted and returned so
 * direct unit callers and IPC stream handlers can choose the shape they need.
 */
export async function runClone(
  options: RunCloneOptions,
  onEvent: (event: GitCloneEvent) => void,
  signal?: AbortSignal,
): Promise<GitCloneStreamResultEvent> {
  throwIfAborted(signal);
  const prepared = await prepareClone(options);
  await createOwnedDestination(prepared.absPath);

  onEvent({ kind: "started", absPath: prepared.absPath });

  if (signal?.aborted) {
    return emitCancelled(prepared.absPath, onEvent);
  }

  const result = await runCloneProcess(options, prepared, (event) => onEvent(event), signal);
  onEvent(result);
  return result;
}

/**
 * Validates user input, derives the final folder name, and normalizes paths.
 */
async function prepareClone(options: RunCloneOptions): Promise<PreparedClone> {
  const url = options.url.trim();
  if (url.length === 0) {
    throw new GitError("clone-url-invalid", "Clone URL is required", {
      argv: ["clone", options.url],
    });
  }

  const parentDir = path.resolve(options.destination);
  if (!path.isAbsolute(options.destination)) {
    throw new GitError("clone-destination-invalid", "Clone destination must be absolute", {
      argv: ["clone", url],
    });
  }

  await assertWritableDirectory(parentDir, url);

  const name = normalizeCloneName(options.name ?? deriveCloneNameFromUrl(url), url);
  const absPath = path.join(parentDir, name);
  if (path.dirname(absPath) !== parentDir) {
    throw new GitError("clone-name-invalid", "Clone folder name is invalid", {
      argv: ["clone", url, absPath],
    });
  }

  const branch = options.branch?.trim() || undefined;
  return {
    url,
    parentDir,
    name,
    absPath,
    branch,
    recurseSubmodules: options.recurseSubmodules === true,
  };
}

/**
 * Creates the target directory before launching Git, making cleanup ownership
 * explicit while still rejecting user-created pre-existing destinations.
 */
async function createOwnedDestination(absPath: string): Promise<void> {
  try {
    await fs.promises.mkdir(absPath, { recursive: false, mode: 0o755 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new GitError("clone-destination-exists", "Clone destination already exists", {
        argv: ["clone", absPath],
        cause: error,
      });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new GitError("clone-destination-not-writable", "Clone destination is not writable", {
        argv: ["clone", absPath],
        cause: error,
      });
    }
    throw new GitError("clone-destination-invalid", "Clone destination is invalid", {
      argv: ["clone", absPath],
      cause: error,
    });
  }
}

/**
 * Launches the child process and maps stderr progress plus terminal state.
 */
async function runCloneProcess(
  options: RunCloneOptions,
  prepared: PreparedClone,
  onEvent: (event: GitCloneStreamProgressEvent) => void,
  signal?: AbortSignal,
): Promise<GitCloneStreamResultEvent> {
  const args = buildCloneArgs(prepared);
  const child = spawnClone(options.bin, prepared.parentDir, args, options.env);
  const parser = new GitCloneProgressParser();
  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  let pendingProgressText = "";
  let cancelled = false;
  let abortTimer: NodeJS.Timeout | null = null;
  let pendingFailure: Error | null = null;

  /** Removes process listeners that should not outlive the clone. */
  const cleanup = (): void => {
    signal?.removeEventListener("abort", onAbort);
    if (abortTimer) clearTimeout(abortTimer);
  };

  /** Requests clone cancellation and schedules a hard kill if Git ignores it. */
  const onAbort = (): void => {
    cancelled = true;
    killChild(child, "SIGTERM");
    abortTimer = setTimeout(() => killChild(child, "SIGKILL"), ABORT_KILL_GRACE_MS);
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    pendingProgressText = consumeCloneProgressText(
      pendingProgressText + chunk.toString("utf8"),
      parser,
      onEvent,
    );
  });

  const exit = await waitForChild(child, options.bin, args, (error) => {
    pendingFailure = error;
  });
  cleanup();
  consumeCloneProgressText(pendingProgressText, parser, onEvent, true);

  if (cancelled || signal?.aborted) {
    return emitCancelled(prepared.absPath);
  }

  if (pendingFailure) throw pendingFailure;
  if (exit.code === 0) return { kind: "complete", absPath: prepared.absPath };

  throw gitErrorFromExit({
    args,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    exitCode: exit.code,
    signal: exit.signal,
  });
}

/**
 * Builds the `git clone` argv with optional branch and submodule flags.
 */
function buildCloneArgs(prepared: PreparedClone): string[] {
  const args = ["clone", "--progress"];
  if (prepared.branch) args.push("--branch", prepared.branch);
  if (prepared.recurseSubmodules) args.push("--recurse-submodules");
  args.push(prepared.url, prepared.absPath);
  return args;
}

/**
 * Spawns git with the interactive helper environment used for HTTPS and SSH
 * credential/passphrase prompts.
 */
function spawnClone(
  bin: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): GitCloneChild {
  return spawn(bin, [...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      ...buildHelperEnv({ askpass: true }),
      GIT_FLUSH: "1",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Resolves when the child exits or fails to spawn.
 */
function waitForChild(
  child: GitCloneChild,
  bin: string,
  args: readonly string[],
  onError: (error: Error) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        onError(gitMissingError(bin, args, error));
      } else {
        onError(unknownGitError(error.message, args, error));
      }
      settle({ code: null, signal: null });
    });
    child.on("close", (code, signal) => {
      settle({ code, signal });
    });
  });
}

/**
 * Emits parser events for every complete carriage-return/newline progress row.
 */
function consumeCloneProgressText(
  text: string,
  parser: GitCloneProgressParser,
  onEvent: (event: GitCloneStreamProgressEvent) => void,
  flush = false,
): string {
  const parts = text.split(/\r|\n/);
  const pending = flush ? "" : (parts.pop() ?? "");
  const complete = parts;
  for (const line of complete) {
    if (line.trim().length === 0) continue;
    for (const event of parser.parseLine(line)) {
      onEvent(event);
    }
  }
  return pending;
}

/**
 * Derives a default local folder name from common URL syntaxes.
 */
export function deriveCloneNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const lastSlash = withoutQuery.lastIndexOf("/");
  const lastColon = withoutQuery.lastIndexOf(":");
  const pivot = Math.max(lastSlash, lastColon);
  const rawName = pivot >= 0 ? withoutQuery.slice(pivot + 1) : withoutQuery;
  return rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
}

/**
 * Applies the clone folder naming rule used to keep target ownership clear.
 */
function normalizeCloneName(name: string, url: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    trimmed.startsWith(".") ||
    !CLONE_NAME_PATTERN.test(trimmed)
  ) {
    throw new GitError("clone-name-invalid", "Clone folder name is invalid", {
      argv: ["clone", url, trimmed],
    });
  }
  return trimmed;
}

/**
 * Verifies the parent destination is an absolute writable directory.
 */
async function assertWritableDirectory(parentDir: string, url: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(parentDir);
    if (!stat.isDirectory()) {
      throw new GitError("clone-destination-invalid", "Clone parent is not a directory", {
        argv: ["clone", url, parentDir],
      });
    }
    await fs.promises.access(parentDir, fs.constants.W_OK);
  } catch (error) {
    if (error instanceof GitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new GitError(
      code === "EACCES" || code === "EPERM"
        ? "clone-destination-not-writable"
        : "clone-destination-invalid",
      code === "EACCES" || code === "EPERM"
        ? "Clone destination is not writable"
        : "Clone destination is invalid",
      { argv: ["clone", url, parentDir], cause: error },
    );
  }
}

/**
 * Removes only the destination directory created by this clone attempt.
 */
async function cleanupOwnedDestination(absPath: string): Promise<boolean> {
  try {
    await fs.promises.rm(absPath, { recursive: true, force: true });
    return !(await pathExists(absPath));
  } catch {
    return false;
  }
}

/**
 * Creates and emits the terminal cancellation event.
 */
async function emitCancelled(
  absPath: string,
  onEvent?: (event: GitCloneEvent) => void,
): Promise<GitCloneStreamResultEvent> {
  const cleaned = await cleanupOwnedDestination(absPath);
  const event: GitCloneStreamResultEvent = { kind: "cancelled", absPath, cleaned };
  onEvent?.(event);
  return event;
}

/**
 * Checks path existence without surfacing ENOENT as an exception.
 */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.promises.access(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Requests child termination with a signal supported by Node's child API.
 */
function killChild(child: GitCloneChild, signal: NodeJS.Signals): void {
  if (child.killed) return;
  child.kill(signal);
}

/**
 * Throws the standard AbortError shape before a clone owns a destination.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}
