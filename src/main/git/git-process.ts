/**
 * Main-process Git child-process runner. `runGit` buffers small command
 * output, while `streamGit` exposes stdout chunks for large log/diff flows.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  GitError,
  gitErrorFromExit,
  gitMissingError,
  outputTooLargeGitError,
  unknownGitError,
} from "./git-error";

export const RUN_GIT_STDOUT_CAP_BYTES = 10 * 1024 * 1024;

const ABORT_KILL_GRACE_MS = 1_000;
type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const GIT_PROCESS_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  SSH_ASKPASS_REQUIRE: "force",
  SSH_ASKPASS: "echo",
  GIT_FLUSH: "1",
} as const;

export interface GitProcessOptions {
  readonly bin: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** True lets caller-provided askpass helpers handle prompts; false injects echo. */
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
}

export interface RunGitOptions extends GitProcessOptions {
  readonly stdoutCapBytes?: number;
}

export interface RunGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Cap on the number of times `runGit` will re-attempt an operation that
 * failed with `kind: "lock-busy"`. The total worst-case wait is
 * `Σ(i² × LOCK_RETRY_BASE_DELAY_MS)` for `i ∈ [1..N]` ≈ 9.6s at the
 * current settings, which mirrors the policy VS Code's git extension uses.
 */
export const LOCK_RETRY_MAX_ATTEMPTS = 10;
export const LOCK_RETRY_BASE_DELAY_MS = 50;

export interface WithLockRetryOptions {
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  /** Delay (in milliseconds) before re-trying after attempt `n` (1-based). */
  readonly backoffMs?: (attempt: number) => number;
}

/**
 * Runs git to completion, buffering stdout up to a bounded byte cap.
 *
 * Transient `kind: "lock-busy"` failures (`.git/index.lock` contention,
 * "another git process seems to be running…") are retried with quadratic
 * backoff. All other GitErrors propagate on the first attempt so callers
 * see a single deterministic failure.
 */
export function runGit(options: RunGitOptions): Promise<RunGitResult> {
  return withLockRetry(() => runGitOnce(options), { signal: options.signal });
}

/**
 * Re-invokes `attempt` up to `maxAttempts` times when it rejects with a
 * `kind: "lock-busy"` GitError, sleeping `backoffMs(n)` between tries.
 * Exported so the runtime call path and unit tests can share the same
 * retry semantics; production callers normally go through `runGit`.
 */
export async function withLockRetry<T>(
  attempt: () => Promise<T>,
  options: WithLockRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? LOCK_RETRY_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? defaultLockBackoffMs;

  for (let i = 1; ; i++) {
    if (options.signal?.aborted) throw createAbortError();
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryableLockError(error) || i >= maxAttempts) throw error;
      await delayWithAbort(backoff(i), options.signal);
    }
  }
}

/**
 * Default quadratic backoff curve. Attempt 1 → 50ms, attempt 2 → 200ms,
 * …, attempt 10 → 5000ms.
 */
function defaultLockBackoffMs(attempt: number): number {
  return attempt * attempt * LOCK_RETRY_BASE_DELAY_MS;
}

/**
 * Lock contention is the only failure category the retry layer treats as
 * transient. Auth/conflict/missing/etc. resolve to user action, not
 * waiting, so they bypass the retry loop.
 */
function isRetryableLockError(error: unknown): boolean {
  return error instanceof GitError && error.kind === "lock-busy";
}

/**
 * Promise-based delay that respects an external AbortSignal — clearing the
 * timer so an aborted retry does not hold an unhandled handle to the event
 * loop.
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Single-shot git invocation. Composed by `runGit` (with retry) and used
 * directly by tests that want to observe the unwrapped failure mode.
 */
function runGitOnce(options: RunGitOptions): Promise<RunGitResult> {
  const stdoutCapBytes = options.stdoutCapBytes ?? RUN_GIT_STDOUT_CAP_BYTES;
  if (options.signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const child = spawnGit(options);
    let closed = false;
    let abortTimer: NodeJS.Timeout | null = null;
    let pendingFailure: Error | null = null;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    /** Ensures listeners and force-kill timers do not outlive the child. */
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      if (abortTimer) clearTimeout(abortTimer);
    };

    /** Records the first terminal failure and asks the child to stop. */
    const failAndKill = (error: Error): void => {
      if (!pendingFailure) pendingFailure = error;
      killChild(child);
    };

    /** Converts AbortSignal cancellation into an AbortError and kills git. */
    const onAbort = (): void => {
      failAndKill(createAbortError());
      abortTimer = scheduleForceKill(child);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (pendingFailure) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutCapBytes) {
        failAndKill(outputTooLargeGitError({ args: options.args, limitBytes: stdoutCapBytes }));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        pendingFailure = gitMissingError(options.bin, options.args, error);
        return;
      }
      pendingFailure = unknownGitError(error.message, options.args, error);
    });

    child.on("close", (code, signal) => {
      closed = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (pendingFailure) {
        if (pendingFailure instanceof GitError && pendingFailure.kind === "output-too-large") {
          reject(
            outputTooLargeGitError({
              args: options.args,
              limitBytes: stdoutCapBytes,
              stderr,
            }),
          );
          return;
        }
        reject(pendingFailure);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }

      reject(
        gitErrorFromExit({
          args: options.args,
          stderr,
          stdout,
          exitCode: code,
          signal,
        }),
      );
    });

    if (options.signal?.aborted && !closed) onAbort();
  });
}

/**
 * Streams git stdout chunks and kills the child when the consumer stops early.
 */
export async function* streamGit(
  options: GitProcessOptions,
): AsyncGenerator<Buffer, void, unknown> {
  if (options.signal?.aborted) throw createAbortError();

  const child = spawnGit(options);
  let closed = false;
  let consumerStopped = true;
  let abortTimer: NodeJS.Timeout | null = null;
  let pendingFailure: Error | null = null;
  const stderrChunks: Buffer[] = [];

  /** Removes abort listeners and any pending hard-kill timer. */
  const cleanup = (): void => {
    options.signal?.removeEventListener("abort", onAbort);
    if (abortTimer) clearTimeout(abortTimer);
  };

  /** Converts external cancellation into an AbortError and terminates git. */
  const onAbort = (): void => {
    if (!pendingFailure) pendingFailure = createAbortError();
    killChild(child);
    abortTimer = scheduleForceKill(child);
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        pendingFailure = gitMissingError(options.bin, options.args, error);
        return;
      }
      pendingFailure = unknownGitError(error.message, options.args, error);
    });
    child.on("close", (code, signal) => {
      closed = true;
      cleanup();
      resolve({ code, signal });
    });
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  try {
    for await (const chunk of child.stdout) {
      if (pendingFailure) break;
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    consumerStopped = false;

    const result = await exit;
    if (pendingFailure) throw pendingFailure;
    if (result.code !== 0) {
      throw gitErrorFromExit({
        args: options.args,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: result.code,
        signal: result.signal,
      });
    }
  } finally {
    cleanup();
    if (consumerStopped && !closed) {
      killChild(child);
      abortTimer = scheduleForceKill(child);
      await exit.catch(() => {});
      cleanup();
    }
  }
}

/**
 * Spawns git with the non-interactive environment required for SCM commands.
 */
function spawnGit(options: GitProcessOptions): GitChildProcess {
  return spawn(options.bin, [...options.args], {
    cwd: options.cwd,
    env: buildGitEnv(options.env, options.interactive ?? false),
    detached: options.interactive === true && process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Merges caller-supplied environment with git prompt policy variables.
 */
function buildGitEnv(env: NodeJS.ProcessEnv | undefined, interactive: boolean): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: GIT_PROCESS_ENV.GIT_TERMINAL_PROMPT,
    GIT_FLUSH: GIT_PROCESS_ENV.GIT_FLUSH,
  };

  if (!interactive) {
    return {
      ...merged,
      GIT_ASKPASS: GIT_PROCESS_ENV.GIT_ASKPASS,
      SSH_ASKPASS_REQUIRE: GIT_PROCESS_ENV.SSH_ASKPASS_REQUIRE,
      SSH_ASKPASS: GIT_PROCESS_ENV.SSH_ASKPASS,
    };
  }

  unsetInheritedPromptEnv(merged, env, "GIT_ASKPASS");
  unsetInheritedPromptEnv(merged, env, "SSH_ASKPASS");
  unsetInheritedPromptEnv(merged, env, "SSH_ASKPASS_REQUIRE");
  return merged;
}

/**
 * Removes inherited prompt helpers unless the caller supplied an override.
 */
function unsetInheritedPromptEnv(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv | undefined,
  key: string,
): void {
  if (overrides && Object.hasOwn(overrides, key)) return;
  delete env[key];
}

/**
 * Requests graceful termination, falling back to platform defaults if needed.
 */
function killChild(child: GitChildProcess): void {
  if (child.killed) return;
  child.kill("SIGTERM");
}

/**
 * Escalates cancellation if a child ignores the first termination signal.
 */
function scheduleForceKill(child: GitChildProcess): NodeJS.Timeout {
  return setTimeout(() => {
    child.kill("SIGKILL");
  }, ABORT_KILL_GRACE_MS);
}

/**
 * Creates the standard AbortError shape used by IPC stream cancellation.
 */
function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
