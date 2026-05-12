import type { GitActionHint } from "../../shared/types/git";
import {
  AUTH_REQUIRED_STDERR_PATTERNS,
  AUTH_STDERR_PATTERNS,
  BINARY_TOO_LARGE_STDERR_PATTERNS,
  BRANCH_CHECKED_OUT_STDERR_PATTERNS,
  BRANCH_EXISTS_STDERR_PATTERNS,
  BRANCH_NAME_INVALID_STDERR_PATTERNS,
  BRANCH_NOT_FULLY_MERGED_STDERR_PATTERNS,
  BRANCH_NOT_MERGED_STDERR_PATTERNS,
  CHERRY_PICK_ALREADY_IN_PROGRESS_STDERR_PATTERNS,
  CLONE_DESTINATION_EXISTS_STDERR_PATTERNS,
  CLONE_DESTINATION_INVALID_STDERR_PATTERNS,
  CLONE_DESTINATION_NOT_WRITABLE_STDERR_PATTERNS,
  CLONE_NAME_INVALID_STDERR_PATTERNS,
  CLONE_URL_INVALID_STDERR_PATTERNS,
  COMMIT_ABORTED_STDERR_PATTERNS,
  CONFLICT_STDERR_PATTERNS,
  EMPTY_COMMIT_STDERR_PATTERNS,
  EMPTY_STASH_STDERR_PATTERNS,
  FILE_NOT_IN_HEAD_STDERR_PATTERNS,
  FORCE_PUSH_REJECTED_STDERR_PATTERNS,
  GITIGNORE_WRITE_FAILED_STDERR_PATTERNS,
  LOCAL_CHANGES_OVERWRITTEN_STDERR_PATTERNS,
  LOCK_BUSY_STDERR_PATTERNS,
  MERGE_ALREADY_IN_PROGRESS_STDERR_PATTERNS,
  MISSING_STDERR_PATTERNS,
  NO_HEAD_STDERR_PATTERNS,
  NO_LOCAL_CHANGES_STDERR_PATTERNS,
  NO_MERGE_BASE_STDERR_PATTERNS,
  NO_OPERATION_IN_PROGRESS_STDERR_PATTERNS,
  NO_PARENT_STDERR_PATTERNS,
  NO_REMOTE_STDERR_PATTERNS,
  NO_UPSTREAM_STDERR_PATTERNS,
  NON_FAST_FORWARD_STDERR_PATTERNS,
  NOT_REPO_STDERR_PATTERNS,
  NOTHING_TO_COMMIT_STDERR_PATTERNS,
  PATH_NOT_CONFLICTED_STDERR_PATTERNS,
  PATH_NOT_IN_REPO_STDERR_PATTERNS,
  PRE_RECEIVE_HOOK_REJECTED_STDERR_PATTERNS,
  PROTECTED_BRANCH_STDERR_PATTERNS,
  PUSH_REJECTED_STDERR_PATTERNS,
  REBASE_ALREADY_IN_PROGRESS_STDERR_PATTERNS,
  REF_NOT_FOUND_STDERR_PATTERNS,
  REMOTE_EXISTS_STDERR_PATTERNS,
  REMOTE_NAME_INVALID_STDERR_PATTERNS,
  REMOTE_NOT_FOUND_STDERR_PATTERNS,
  REMOTE_URL_INVALID_STDERR_PATTERNS,
  SIGNING_FAILED_STDERR_PATTERNS,
  STASH_CONFLICT_STDERR_PATTERNS,
  STASH_NOT_FOUND_STDERR_PATTERNS,
  TAG_EXISTS_STDERR_PATTERNS,
  TAG_NAME_INVALID_STDERR_PATTERNS,
  TAG_NOT_FOUND_STDERR_PATTERNS,
  UNRELATED_HISTORIES_STDERR_PATTERNS,
  UNRESOLVED_CONFLICTS_STDERR_PATTERNS,
  UPSTREAM_INVALID_STDERR_PATTERNS,
} from "./git-stderr-patterns";

/**
 * Typed Git errors shared by the main-process git resolver, process runner,
 * and future IPC handlers so renderer-facing code can branch on a stable kind.
 *
 * Kinds split into two families:
 *
 *   - Stderr-derived (`auth`, `conflict`, `missing`, `lock-busy`, …) classify
 *     a real Git process that exited with non-zero. Patterns live in
 *     `./git-stderr-patterns.ts`; this module owns the priority order in
 *     `classifyGitStderr`. The catalog mirrors what VS Code's git extension
 *     uses so the renderer can branch on stable codes regardless of git
 *     version or locale variations in the underlying stderr text.
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
