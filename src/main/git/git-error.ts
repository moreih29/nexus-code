/**
 * Typed Git errors shared by the main-process git resolver, process runner,
 * and future IPC handlers so renderer-facing code can branch on a stable kind.
 */
export type GitErrorKind =
  | "auth"
  | "conflict"
  | "not-repo"
  | "missing"
  | "output-too-large"
  | "git-missing"
  | "unknown";

export interface GitErrorOptions {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | null;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly argv?: readonly string[];
  readonly cause?: unknown;
}

const AUTH_STDERR_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /invalid username or password/i,
  /permission denied \(publickey\)/i,
  /permission denied, please try again/i,
  /terminal prompts disabled/i,
];

const CONFLICT_STDERR_PATTERNS = [
  /automatic merge failed/i,
  /\bconflict\b/i,
  /fix conflicts and then commit/i,
  /you have unmerged paths/i,
  /unmerged files/i,
  /needs merge/i,
  /would be overwritten by (merge|checkout)/i,
  /non-fast-forward/i,
  /failed to push some refs/i,
];

const NOT_REPO_STDERR_PATTERNS = [
  /not a git repository/i,
  /no git repository/i,
  /not in a git directory/i,
  /must be run in a work tree/i,
];

// Patterns Git emits when a requested ref or path could not be resolved to an
// object. Surfaced as kind:"missing" so read-op consumers (diff tab) can render
// the (missing) placeholder instead of an error banner. Classifier ordering
// puts conflict before missing because "would be overwritten by checkout"
// mentions paths and would otherwise be miscategorized.
const MISSING_STDERR_PATTERNS = [
  /invalid object name/i,
  /pathspec .+ did not match/i,
  /path .+ does not exist in/i,
  /exists on disk, but not in/i,
  /did not match any file/i,
  /unknown revision or path not in the working tree/i,
];

/**
 * Error subclass used for every expected git-process failure mode.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly stdout: string;
  readonly code: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly argv: readonly string[];

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
  }
}

/**
 * Classifies stderr that Git emits for credential or authorization failures.
 */
export function isAuthStderr(stderr: string): boolean {
  return AUTH_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Classifies stderr emitted when the repository has unresolved state.
 */
export function isConflictStderr(stderr: string): boolean {
  return CONFLICT_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Classifies stderr emitted when the cwd is not inside a Git repository.
 */
export function isNotRepoStderr(stderr: string): boolean {
  return NOT_REPO_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Classifies stderr emitted when a ref or path cannot be resolved to a Git
 * object — used by read ops (diff tab, future blame/log-at-ref) to surface a
 * (missing) placeholder instead of an error.
 */
export function isMissingStderr(stderr: string): boolean {
  return MISSING_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Maps a Git stderr payload to the closest renderer-visible error kind.
 * Conflict is checked before missing because "would be overwritten by
 * checkout" mentions paths and would otherwise misclassify as missing.
 */
export function classifyGitStderr(stderr: string): GitErrorKind {
  if (isAuthStderr(stderr)) return "auth";
  if (isConflictStderr(stderr)) return "conflict";
  if (isNotRepoStderr(stderr)) return "not-repo";
  if (isMissingStderr(stderr)) return "missing";
  return "unknown";
}

/**
 * Builds the typed error for a git process that exited unsuccessfully.
 */
export function gitErrorFromExit(options: {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}): GitError {
  const kind = classifyGitStderr(options.stderr);
  const renderedCommand = renderGitCommand(options.args);
  const message = messageFromGitFailure(
    kind,
    renderedCommand,
    options.stderr,
    options.exitCode,
    options.signal,
  );
  return new GitError(kind, message, {
    argv: options.args,
    stderr: options.stderr,
    stdout: options.stdout,
    code: options.exitCode,
    exitCode: options.exitCode,
    signal: options.signal,
  });
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
 * Formats a compact command label without including environment variables.
 */
function renderGitCommand(args: readonly string[]): string {
  return ["git", ...args].join(" ");
}

/**
 * Chooses the most useful process-failure message while preserving stderr.
 */
function messageFromGitFailure(
  kind: GitErrorKind,
  renderedCommand: string,
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  const trimmed = stderr.trim();
  if (trimmed.length > 0) return trimmed;
  if (signal) return `${renderedCommand} exited with signal ${signal}`;
  if (exitCode !== null) return `${renderedCommand} exited with code ${exitCode}`;
  if (kind === "auth") return "Git authentication failed";
  if (kind === "conflict") return "Git operation conflicted";
  if (kind === "not-repo") return "Not a Git repository";
  if (kind === "missing") return "Object or path not found in Git";
  return `${renderedCommand} failed`;
}

/**
 * Converts a byte count into the small human-readable unit used in errors.
 */
function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(Number.isInteger(mib) ? 0 : 1)} MB`;
}
