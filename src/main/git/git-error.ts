import type { GitActionHint } from "../../shared/types/git";

/**
 * Typed Git errors shared by the main-process git resolver, process runner,
 * and future IPC handlers so renderer-facing code can branch on a stable kind.
 *
 * Kinds split into two families:
 *
 *   - Stderr-derived (`auth`, `conflict`, `missing`, `lock-busy`, …) classify
 *     a real Git process that exited with non-zero. Patterns in this file
 *     decide which. The catalog mirrors what VS Code's git extension uses
 *     so the renderer can branch on stable codes regardless of git version
 *     or locale variations in the underlying stderr text.
 *   - Preflight-derived (`no-head`, `no-such-ref`, …) are emitted by
 *     `src/main/git/git-preflight` before Git is invoked. They carry an
 *     optional `hint` payload so the renderer can offer one-click recovery
 *     (Publish branch, Track remote, Make initial commit) instead of
 *     showing raw stderr.
 *
 * `unknown` remains the catch-all for fall-through stderr that did not match
 * any pattern.
 */
export type GitErrorKind =
  | "auth"
  | "conflict"
  | "not-repo"
  | "missing"
  | "output-too-large"
  | "git-missing"
  | "no-head"
  | "no-upstream"
  | "no-remote"
  | "no-such-ref"
  | "empty-stash"
  | "dirty-tree"
  | "lock-busy"
  | "local-changes-overwritten"
  | "branch-exists"
  | "push-rejected"
  | "force-push-rejected"
  | "no-local-changes"
  | "branch-not-merged"
  | "unknown";

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

// `.git/index.lock` and friends — race when another git process is mid-write.
// `git-process` retries operations in this category with quadratic backoff.
const LOCK_BUSY_STDERR_PATTERNS = [
  /another git process seems to be running/i,
  /could not lock config file/i,
  /unable to create '?[^']*\.git\/(index|.*\.lock)'? *: file exists/i,
  /\.lock'?: file exists/i,
  /cannot lock ref/i,
];

// Git refuses to overwrite uncommitted edits during checkout/merge/stash apply.
const LOCAL_CHANGES_OVERWRITTEN_STDERR_PATTERNS = [
  /your local changes to the following files would be overwritten by (checkout|merge|rebase|stash)/i,
  /please commit your changes or stash them before you (switch|merge|rebase)/i,
];

const BRANCH_EXISTS_STDERR_PATTERNS = [
  /a branch named '.+' already exists/i,
  /^fatal: A branch named '.+' already exists/im,
];

// `git push` was rejected. Force-with-lease rejection is split out so the UI
// can surface a different message ("remote moved — fetch first") vs. an
// ordinary non-fast-forward push rejection.
const FORCE_PUSH_REJECTED_STDERR_PATTERNS = [
  /stale info/i,
  /rejected.*because the remote contains work that you do/i,
];

const PUSH_REJECTED_STDERR_PATTERNS = [
  /\[rejected\]/i,
  /failed to push some refs/i,
  /non-fast-forward/i,
  /updates were rejected/i,
];

// Stash apply / pop with no matching changes; commit --amend with no edits.
// Empty-stash gets its own bucket below so the renderer can distinguish
// "you have no work to record" from "the stash stack is empty".
const NO_LOCAL_CHANGES_STDERR_PATTERNS = [
  /no changes added to commit/i,
  /no local changes to save/i,
  /nothing to commit/i,
];

const EMPTY_STASH_STDERR_PATTERNS = [
  /no stash entries found/i,
  /\bno stash found\b/i,
];

const BRANCH_NOT_MERGED_STDERR_PATTERNS = [
  /the branch '.+' is not fully merged/i,
];

// Preflight-aligned stderr matchers — git's actual error text for the same
// situations our preflight catches. Lets us drop redundant preflight calls
// once classification is good enough on its own.
const NO_HEAD_STDERR_PATTERNS = [
  /you do not have the initial commit yet/i,
  /does not have any commits yet/i,
  /bad default revision 'HEAD'/i,
];

const NO_UPSTREAM_STDERR_PATTERNS = [
  /there is no tracking information for the current branch/i,
  /no upstream configured for branch/i,
  /the current branch [^ ]+ has no upstream branch/i,
];

const NO_REMOTE_STDERR_PATTERNS = [
  /no configured push destination/i,
  /'[^']*' does not appear to be a git repository/i,
  /no such remote /i,
  /no remote repository specified/i,
  /no remote configured to list refs/i,
];

/**
 * Error subclass used for every expected git-process failure mode.
 *
 * `hint` is set only by preflight constructors; stderr-classified errors
 * leave it undefined. The renderer treats a missing hint as "no actionable
 * recovery — show the stderr message".
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
 * Classifies stderr emitted when another git process holds a lock — `git-process`
 * retries operations with this kind via quadratic backoff before giving up.
 */
export function isLockBusyStderr(stderr: string): boolean {
  return LOCK_BUSY_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Maps a Git stderr payload to the closest renderer-visible error kind.
 *
 * Ordering matters and is documented inline. The most specific patterns run
 * first so a single stderr line like "Your local changes to the following
 * files would be overwritten by checkout" classifies as
 * `local-changes-overwritten` rather than the broader `conflict` group.
 */
export function classifyGitStderr(stderr: string): GitErrorKind {
  // Auth must precede everything: a credential failure can mention paths
  // ("could not read from remote repository") and would otherwise leak into
  // missing/conflict groups.
  if (isAuthStderr(stderr)) return "auth";

  // Lock contention is purely transient and should be detected before
  // generic patterns so the retry layer can act on it.
  if (isLockBusyStderr(stderr)) return "lock-busy";

  // The "your local changes would be overwritten" family is split off from
  // conflict because the recovery is different (commit/stash vs resolve).
  if (LOCAL_CHANGES_OVERWRITTEN_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "local-changes-overwritten";
  }

  // Force-push rejection ("stale info") must precede plain push rejection.
  if (FORCE_PUSH_REJECTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "force-push-rejected";
  }
  if (PUSH_REJECTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "push-rejected";
  }

  if (BRANCH_EXISTS_STDERR_PATTERNS.some((p) => p.test(stderr))) return "branch-exists";
  if (BRANCH_NOT_MERGED_STDERR_PATTERNS.some((p) => p.test(stderr))) return "branch-not-merged";

  // Empty-stash before no-local-changes so "No stash entries found" lands
  // on its own kind instead of the broader "nothing to commit" bucket.
  if (EMPTY_STASH_STDERR_PATTERNS.some((p) => p.test(stderr))) return "empty-stash";
  if (NO_LOCAL_CHANGES_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-local-changes";

  // Preflight-aligned classifications. Run before the broader missing
  // pattern so "no upstream configured" doesn't leak into kind:"missing".
  if (NO_HEAD_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-head";
  if (NO_UPSTREAM_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-upstream";
  if (NO_REMOTE_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-remote";

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
  // Fallback messages used when stderr is empty (rare). Prefer the typed
  // kind to give the renderer something useful instead of a bare exit code.
  switch (kind) {
    case "auth":
      return "Git authentication failed";
    case "conflict":
      return "Git operation conflicted";
    case "not-repo":
      return "Not a Git repository";
    case "missing":
      return "Object or path not found in Git";
    case "lock-busy":
      return "Another git process is holding the repository lock";
    case "local-changes-overwritten":
      return "Local changes would be overwritten — commit or stash first";
    case "branch-exists":
      return "A branch with that name already exists";
    case "push-rejected":
      return "Push rejected — fetch and merge first";
    case "force-push-rejected":
      return "Force push rejected — fetch first to refresh your local view";
    case "no-local-changes":
      return "No changes to record";
    case "branch-not-merged":
      return "Branch is not fully merged";
    case "no-head":
      return "Repository has no commits yet";
    case "no-upstream":
      return "Current branch has no upstream";
    case "no-remote":
      return "No git remote configured";
    case "no-such-ref":
      return "Reference not found";
    case "empty-stash":
      return "Stash is empty";
    case "dirty-tree":
      return "Working tree has uncommitted changes";
    case "git-missing":
      return "Git executable not found";
    case "output-too-large":
      return "Git output exceeded the configured limit";
    case "unknown":
      return `${renderedCommand} failed`;
  }
}

/**
 * Converts a byte count into the small human-readable unit used in errors.
 */
function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(Number.isInteger(mib) ? 0 : 1)} MB`;
}
