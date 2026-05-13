import type { AgentGitRunResult } from "../../shared/protocol/agent/git";
import type { GitActionHint, GitErrorKind } from "../../shared/types/git";

export type { GitErrorKind };

export interface GitErrorOptions {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | null;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly argv?: readonly string[];
  readonly cause?: unknown;
  readonly hint?: GitActionHint;
}

/**
 * Error subclass used as the runtime marker for expected Git failures.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly stdout: string;
  readonly code: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;

  constructor(kind: GitErrorKind, message: string, options: GitErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "GitError";
    this.kind = kind;
    this.stderr = options.stderr ?? "";
    this.stdout = options.stdout ?? "";
    this.code = options.code ?? options.exitCode ?? null;
    this.exitCode = this.code;
    this.signal = options.signal ?? null;
    this.argv = options.argv ?? [];
    this.hint = options.hint;
  }
}

/**
 * Re-wraps the agent-classified git.run envelope as the TS GitError marker.
 */
export function gitErrorFromAgent(
  result: AgentGitRunResult,
  args: readonly string[],
  cause?: unknown,
): GitError {
  const kind = result.errorKind ?? "unknown";
  return new GitError(kind, agentGitErrorMessage(result, args), {
    argv: args,
    stderr: result.stderr,
    stdout: result.stdout,
    code: result.code,
    exitCode: result.code,
    signal: null,
    hint: result.errorHint,
    cause,
  });
}

/**
 * Builds a minimal typed error for legacy local-process exits.
 *
 * This intentionally does not classify stderr; agent envelopes are the source
 * of git error kinds. The local spawn fallback remains only until cleanup.
 */
export function gitErrorFromExit(options: {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}): GitError {
  return new GitError(
    "unknown",
    processExitMessage(options.args, options.stderr, options.exitCode, options.signal),
    {
      argv: options.args,
      stderr: options.stderr,
      stdout: options.stdout,
      code: options.exitCode,
      exitCode: options.exitCode,
      signal: options.signal,
    },
  );
}

/**
 * Builds the typed error for stdout that exceeded the configured safety cap.
 */
export function outputTooLargeGitError(options: {
  readonly args: readonly string[];
  readonly limitBytes: number;
  readonly stderr?: string;
}): GitError {
  return new GitError(
    "output-too-large",
    `Git output exceeded ${formatBytes(options.limitBytes)} limit`,
    {
      argv: options.args,
      stderr: options.stderr,
    },
  );
}

/**
 * Builds the typed error for a configured git binary that cannot be spawned.
 */
export function gitMissingError(bin: string, args: readonly string[], cause?: unknown): GitError {
  return new GitError("git-missing", `Git executable not found: ${bin}`, {
    argv: args,
    cause,
  });
}

/**
 * Builds the fallback typed error for process failures that are not git exits.
 */
export function unknownGitError(
  message: string,
  args: readonly string[],
  cause?: unknown,
): GitError {
  return new GitError("unknown", message, {
    argv: args,
    cause,
  });
}

/**
 * Chooses the best available message from an agent-classified result.
 */
function agentGitErrorMessage(result: AgentGitRunResult, args: readonly string[]): string {
  const agentMessage = result.errorMessage?.trim();
  if (agentMessage) return agentMessage;
  return processExitMessage(args, result.stderr, result.code, null);
}

/**
 * Formats a process exit without inferring a semantic Git error kind.
 */
function processExitMessage(
  args: readonly string[],
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  const trimmed = stderr.trim();
  if (trimmed.length > 0) return trimmed;
  const renderedCommand = renderGitCommand(args);
  if (signal) return `${renderedCommand} exited with signal ${signal}`;
  if (exitCode !== null) return `${renderedCommand} exited with code ${exitCode}`;
  return `${renderedCommand} failed`;
}

/**
 * Formats a compact command label without including environment variables.
 */
function renderGitCommand(args: readonly string[]): string {
  return ["git", ...args].join(" ");
}

/**
 * Converts a byte count into the small human-readable unit used in errors.
 */
function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(Number.isInteger(mib) ? 0 : 1)} MB`;
}
