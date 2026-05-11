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
  | "auth-required"
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
  | "nothing-to-commit"
  | "no-parent"
  | "signing-failed"
  | "binary-too-large"
  | "file-not-in-head"
  | "path-not-in-repo"
  | "gitignore-write-failed"
  | "stash-conflict"
  | "stash-not-found"
  | "commit-aborted"
  | "branch-not-fully-merged"
  | "branch-checked-out"
  | "branch-name-invalid"
  | "branch-exists"
  | "remote-exists"
  | "remote-name-invalid"
  | "remote-url-invalid"
  | "remote-not-found"
  | "tag-exists"
  | "tag-not-found"
  | "tag-name-invalid"
  | "ref-not-found"
  | "upstream-invalid"
  | "merge-already-in-progress"
  | "rebase-already-in-progress"
  | "cherry-pick-already-in-progress"
  | "no-operation-in-progress"
  | "unresolved-conflicts"
  | "unrelated-histories"
  | "no-merge-base"
  | "empty-commit"
  | "path-not-conflicted"
  | "clone-destination-invalid"
  | "clone-destination-not-writable"
  | "clone-destination-exists"
  | "clone-name-invalid"
  | "clone-url-invalid"
  | "non-fast-forward"
  | "protected-branch"
  | "pre-receive-hook-rejected"
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
  /invalid username or password/i,
  /permission denied \(publickey\)/i,
  /permission denied, please try again/i,
];

const AUTH_REQUIRED_STDERR_PATTERNS = [
  /could not read username/i,
  /could not read password/i,
  /terminal prompts disabled/i,
  /no such device or address/i,
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

const GITIGNORE_WRITE_FAILED_STDERR_PATTERNS = [
  /could not write .*\.gitignore/i,
  /failed to write .*\.gitignore/i,
  /unable to write .*\.gitignore/i,
];

const COMMIT_ABORTED_STDERR_PATTERNS = [
  /aborting commit due to empty commit message/i,
  /empty commit message/i,
  /commit aborted/i,
  /there was a problem with the editor/i,
  /please supply the message using either -m or -F option/i,
];

const SIGNING_FAILED_STDERR_PATTERNS = [
  /gpg failed to sign the data/i,
  /failed to sign the commit/i,
  /signing failed/i,
  /couldn'?t load public key/i,
];

const NO_PARENT_STDERR_PATTERNS = [
  /ambiguous argument ['"]?HEAD\^['"]?/i,
  /bad revision ['"]?HEAD\^['"]?/i,
  /unknown revision.*HEAD\^/i,
];

const BINARY_TOO_LARGE_STDERR_PATTERNS = [
  /binary file .+ is too large/i,
  /file .+ is too large to display/i,
  /blob .+ exceeds .* limit/i,
];

const FILE_NOT_IN_HEAD_STDERR_PATTERNS = [
  /path .+ does not exist in ['"]?HEAD['"]?/i,
  /path .+ exists on disk, but not in ['"]?HEAD['"]?/i,
  /fatal: path .+ exists on disk, but not in/i,
];

const PATH_NOT_IN_REPO_STDERR_PATTERNS = [
  /path .+ is outside repository/i,
  /outside repository/i,
  /not under version control/i,
];

const STASH_CONFLICT_STDERR_PATTERNS = [
  /conflicts in index\. try without --index/i,
  /could not restore untracked files from stash/i,
  /stash.*conflict/i,
];

const STASH_NOT_FOUND_STDERR_PATTERNS = [
  /stash@\{\d+\} is not a valid reference/i,
  /log for ['"]?refs\/stash['"]? only has \d+ entries/i,
  /no stash entry found/i,
];

const EMPTY_COMMIT_STDERR_PATTERNS = [
  /the previous (cherry-pick|revert) is now empty/i,
  /(cherry-pick|revert) is now empty/i,
  /would make\s+it empty/i,
];

const NOTHING_TO_COMMIT_STDERR_PATTERNS = [
  /nothing to commit/i,
  /no changes added to commit/i,
  /nothing added to commit/i,
];

const BRANCH_NOT_FULLY_MERGED_STDERR_PATTERNS = [
  /the branch '.+' is not fully merged/i,
  /not fully merged/i,
];

const BRANCH_CHECKED_OUT_STDERR_PATTERNS = [
  /cannot delete branch '.+' checked out/i,
  /branch '.+' is checked out at/i,
  /is already checked out at/i,
];

const BRANCH_NAME_INVALID_STDERR_PATTERNS = [
  /not a valid branch name/i,
  /is not a valid name for a branch/i,
  /invalid branch name/i,
];

const BRANCH_EXISTS_STDERR_PATTERNS = [
  /a branch named '.+' already exists/i,
  /^fatal: A branch named '.+' already exists/im,
];

const REMOTE_EXISTS_STDERR_PATTERNS = [/remote .+ already exists/i];

const REMOTE_NAME_INVALID_STDERR_PATTERNS = [
  /'.+' is not a valid remote name/i,
  /invalid remote name/i,
];

const REMOTE_URL_INVALID_STDERR_PATTERNS = [/invalid url/i, /invalid remote url/i];

const REMOTE_NOT_FOUND_STDERR_PATTERNS = [/no such remote/i, /remote .+ does not exist/i];

const TAG_EXISTS_STDERR_PATTERNS = [/tag '.+' already exists/i, /fatal: tag .+ already exists/i];

const TAG_NOT_FOUND_STDERR_PATTERNS = [
  /tag '.+' not found/i,
  /could not delete ref .*tag/i,
  /unable to delete '.+': remote ref does not exist/i,
];

const TAG_NAME_INVALID_STDERR_PATTERNS = [
  /not a valid tag name/i,
  /is not a valid tag name/i,
  /invalid tag name/i,
];

const REF_NOT_FOUND_STDERR_PATTERNS = [
  /failed to resolve '.+' as a valid ref/i,
  /ambiguous argument '.+': unknown revision or path not in the working tree/i,
];

const UPSTREAM_INVALID_STDERR_PATTERNS = [
  /requested upstream branch '.+' does not exist/i,
  /cannot set up tracking information/i,
  /not stored as a remote-tracking branch/i,
];

const MERGE_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /you have not concluded your merge/i,
  /merge_head exists/i,
];

const REBASE_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /rebase-merge directory exists/i,
  /rebase-apply directory exists/i,
  /already a rebase/i,
];

const CHERRY_PICK_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /cherry-pick is already in progress/i,
  /cherry_pick_head exists/i,
];

const NO_OPERATION_IN_PROGRESS_STDERR_PATTERNS = [
  /no cherry-pick or revert in progress/i,
  /no rebase in progress/i,
  /there is no merge to abort/i,
  /no operation is in progress/i,
];

const UNRESOLVED_CONFLICTS_STDERR_PATTERNS = [
  /you need to resolve your current index first/i,
  /committing is not possible because you have unmerged files/i,
  /cannot .* because you have unmerged files/i,
];

const UNRELATED_HISTORIES_STDERR_PATTERNS = [/refusing to merge unrelated histories/i];

const NO_MERGE_BASE_STDERR_PATTERNS = [/no merge base/i, /not possible to fast-forward, aborting/i];

const PATH_NOT_CONFLICTED_STDERR_PATTERNS = [
  /path .+ does not have conflicts/i,
  /path .+ is not conflicted/i,
  /is not an unmerged path/i,
];

const CLONE_DESTINATION_INVALID_STDERR_PATTERNS = [
  /clone destination .* invalid/i,
  /destination path .* is not absolute/i,
];

const CLONE_DESTINATION_NOT_WRITABLE_STDERR_PATTERNS = [
  /could not create work tree dir .+ permission denied/i,
  /permission denied.*clone destination/i,
  /destination .+ is not writable/i,
];

const CLONE_DESTINATION_EXISTS_STDERR_PATTERNS = [
  /destination path '.+' already exists and is not an empty directory/i,
  /destination path .+ already exists/i,
];

const CLONE_NAME_INVALID_STDERR_PATTERNS = [
  /clone name .* invalid/i,
  /repository name .* invalid/i,
];

const CLONE_URL_INVALID_STDERR_PATTERNS = [
  /repository '.+' does not exist/i,
  /clone url .* invalid/i,
  /invalid clone url/i,
];

// `git push` was rejected. Force-with-lease rejection is split out so the UI
// can surface a different message ("remote moved — fetch first") vs. an
// ordinary non-fast-forward push rejection.
const FORCE_PUSH_REJECTED_STDERR_PATTERNS = [/stale info/i];

const NON_FAST_FORWARD_STDERR_PATTERNS = [
  /non-fast-forward/i,
  /tip of your current branch is behind/i,
  /fetch first/i,
  /remote contains work that you do not have locally/i,
];

const PROTECTED_BRANCH_STDERR_PATTERNS = [
  /protected branch hook declined/i,
  /\bgh006\b/i,
  /branch .+ is read-only/i,
  /protected branch/i,
];

const PRE_RECEIVE_HOOK_REJECTED_STDERR_PATTERNS = [
  /pre-receive hook declined/i,
  /pre-receive hook rejected/i,
];

const PUSH_REJECTED_STDERR_PATTERNS = [
  /\[rejected\]/i,
  /failed to push some refs/i,
  /updates were rejected/i,
];

// Stash apply / pop with no matching changes; commit --amend with no edits.
// Empty-stash gets its own bucket below so the renderer can distinguish
// "you have no work to record" from "the stash stack is empty".
const NO_LOCAL_CHANGES_STDERR_PATTERNS = [/no local changes to save/i];

const EMPTY_STASH_STDERR_PATTERNS = [/no stash entries found/i, /\bno stash found\b/i];

const BRANCH_NOT_MERGED_STDERR_PATTERNS = [/the branch '.+' is not fully merged/i];

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
 * Classifies stderr emitted when Git needed credentials but no usable prompt
 * result was available.
 */
export function isAuthRequiredStderr(stderr: string): boolean {
  return AUTH_REQUIRED_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
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
  if (isAuthRequiredStderr(stderr)) return "auth-required";
  if (isAuthStderr(stderr)) return "auth";

  // Lock contention is purely transient and should be detected before
  // generic patterns so the retry layer can act on it.
  if (isLockBusyStderr(stderr)) return "lock-busy";

  // The "your local changes would be overwritten" family is split off from
  // conflict because the recovery is different (commit/stash vs resolve).
  if (LOCAL_CHANGES_OVERWRITTEN_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "local-changes-overwritten";
  }

  if (GITIGNORE_WRITE_FAILED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "gitignore-write-failed";
  }
  if (COMMIT_ABORTED_STDERR_PATTERNS.some((p) => p.test(stderr))) return "commit-aborted";
  if (SIGNING_FAILED_STDERR_PATTERNS.some((p) => p.test(stderr))) return "signing-failed";
  if (NO_PARENT_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-parent";
  if (BINARY_TOO_LARGE_STDERR_PATTERNS.some((p) => p.test(stderr))) return "binary-too-large";
  if (FILE_NOT_IN_HEAD_STDERR_PATTERNS.some((p) => p.test(stderr))) return "file-not-in-head";
  if (PATH_NOT_IN_REPO_STDERR_PATTERNS.some((p) => p.test(stderr))) return "path-not-in-repo";

  if (MERGE_ALREADY_IN_PROGRESS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "merge-already-in-progress";
  }
  if (REBASE_ALREADY_IN_PROGRESS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "rebase-already-in-progress";
  }
  if (CHERRY_PICK_ALREADY_IN_PROGRESS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "cherry-pick-already-in-progress";
  }
  if (NO_OPERATION_IN_PROGRESS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "no-operation-in-progress";
  }
  if (UNRESOLVED_CONFLICTS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "unresolved-conflicts";
  }
  if (UNRELATED_HISTORIES_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "unrelated-histories";
  }
  if (NO_MERGE_BASE_STDERR_PATTERNS.some((p) => p.test(stderr))) return "no-merge-base";
  if (EMPTY_COMMIT_STDERR_PATTERNS.some((p) => p.test(stderr))) return "empty-commit";
  if (PATH_NOT_CONFLICTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "path-not-conflicted";
  }

  if (CLONE_DESTINATION_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "clone-destination-invalid";
  }
  if (CLONE_DESTINATION_NOT_WRITABLE_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "clone-destination-not-writable";
  }
  if (CLONE_DESTINATION_EXISTS_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "clone-destination-exists";
  }
  if (CLONE_NAME_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "clone-name-invalid";
  }
  if (CLONE_URL_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) return "clone-url-invalid";

  if (STASH_CONFLICT_STDERR_PATTERNS.some((p) => p.test(stderr))) return "stash-conflict";
  if (STASH_NOT_FOUND_STDERR_PATTERNS.some((p) => p.test(stderr))) return "stash-not-found";

  // Force-push rejection ("stale info") must precede plain push rejection.
  if (FORCE_PUSH_REJECTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "force-push-rejected";
  }
  if (NON_FAST_FORWARD_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "non-fast-forward";
  }
  if (PROTECTED_BRANCH_STDERR_PATTERNS.some((p) => p.test(stderr))) return "protected-branch";
  if (PRE_RECEIVE_HOOK_REJECTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "pre-receive-hook-rejected";
  }
  if (PUSH_REJECTED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "push-rejected";
  }

  if (BRANCH_NOT_FULLY_MERGED_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "branch-not-fully-merged";
  }
  if (BRANCH_CHECKED_OUT_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "branch-checked-out";
  }
  if (BRANCH_NAME_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "branch-name-invalid";
  }
  if (BRANCH_EXISTS_STDERR_PATTERNS.some((p) => p.test(stderr))) return "branch-exists";
  if (BRANCH_NOT_MERGED_STDERR_PATTERNS.some((p) => p.test(stderr))) return "branch-not-merged";
  if (REMOTE_EXISTS_STDERR_PATTERNS.some((p) => p.test(stderr))) return "remote-exists";
  if (REMOTE_NAME_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) {
    return "remote-name-invalid";
  }
  if (REMOTE_URL_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) return "remote-url-invalid";
  if (REMOTE_NOT_FOUND_STDERR_PATTERNS.some((p) => p.test(stderr))) return "remote-not-found";
  if (TAG_EXISTS_STDERR_PATTERNS.some((p) => p.test(stderr))) return "tag-exists";
  if (TAG_NOT_FOUND_STDERR_PATTERNS.some((p) => p.test(stderr))) return "tag-not-found";
  if (TAG_NAME_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) return "tag-name-invalid";
  if (REF_NOT_FOUND_STDERR_PATTERNS.some((p) => p.test(stderr))) return "ref-not-found";
  if (UPSTREAM_INVALID_STDERR_PATTERNS.some((p) => p.test(stderr))) return "upstream-invalid";

  // Empty-stash before no-local-changes so "No stash entries found" lands
  // on its own kind instead of the broader "nothing to commit" bucket.
  if (EMPTY_STASH_STDERR_PATTERNS.some((p) => p.test(stderr))) return "empty-stash";
  if (NOTHING_TO_COMMIT_STDERR_PATTERNS.some((p) => p.test(stderr))) return "nothing-to-commit";
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
    hint: hintForGitErrorKind(kind),
  });
}

/**
 * Attaches recovery hints for stderr-classified errors whose next action is
 * stable enough for renderer UI to branch on without parsing message text.
 */
function hintForGitErrorKind(kind: GitErrorKind): GitActionHint | undefined {
  switch (kind) {
    case "non-fast-forward":
      return { kind: "pull-then-retry" };
    case "force-push-rejected":
      return { kind: "fetch-then-force" };
    case "unrelated-histories":
      return { kind: "allow-unrelated-histories" };
    case "empty-commit":
      return { kind: "allow-empty" };
    default:
      return undefined;
  }
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
    case "auth-required":
      return "Git authentication is required";
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
    case "nothing-to-commit":
      return "Nothing to commit";
    case "no-parent":
      return "HEAD has no parent commit";
    case "signing-failed":
      return "Git commit signing failed";
    case "binary-too-large":
      return "Binary file is too large";
    case "file-not-in-head":
      return "File does not exist in HEAD";
    case "path-not-in-repo":
      return "Path is not inside the repository";
    case "gitignore-write-failed":
      return "Could not write .gitignore";
    case "stash-conflict":
      return "Stash apply conflicted";
    case "stash-not-found":
      return "Stash entry not found";
    case "commit-aborted":
      return "Commit was aborted";
    case "branch-not-fully-merged":
      return "Branch is not fully merged";
    case "branch-checked-out":
      return "Branch is checked out in another worktree";
    case "branch-name-invalid":
      return "Branch name is invalid";
    case "branch-exists":
      return "A branch with that name already exists";
    case "remote-exists":
      return "A remote with that name already exists";
    case "remote-name-invalid":
      return "Remote name is invalid";
    case "remote-url-invalid":
      return "Remote URL is invalid";
    case "remote-not-found":
      return "Remote not found";
    case "tag-exists":
      return "A tag with that name already exists";
    case "tag-not-found":
      return "Tag not found";
    case "tag-name-invalid":
      return "Tag name is invalid";
    case "ref-not-found":
      return "Reference not found";
    case "upstream-invalid":
      return "Upstream is invalid";
    case "merge-already-in-progress":
      return "A merge is already in progress";
    case "rebase-already-in-progress":
      return "A rebase is already in progress";
    case "cherry-pick-already-in-progress":
      return "A cherry-pick is already in progress";
    case "no-operation-in-progress":
      return "No Git operation is in progress";
    case "unresolved-conflicts":
      return "Resolve conflicts before continuing";
    case "unrelated-histories":
      return "Git histories are unrelated";
    case "no-merge-base":
      return "No merge base found";
    case "empty-commit":
      return "Operation produced an empty commit";
    case "path-not-conflicted":
      return "Path is not conflicted";
    case "clone-destination-invalid":
      return "Clone destination is invalid";
    case "clone-destination-not-writable":
      return "Clone destination is not writable";
    case "clone-destination-exists":
      return "Clone destination already exists";
    case "clone-name-invalid":
      return "Clone folder name is invalid";
    case "clone-url-invalid":
      return "Clone URL is invalid";
    case "non-fast-forward":
      return "Push rejected — pull first";
    case "protected-branch":
      return "Push rejected by protected branch policy";
    case "pre-receive-hook-rejected":
      return "Push rejected by pre-receive hook";
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
