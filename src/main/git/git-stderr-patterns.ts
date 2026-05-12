/**
 * Regex catalog for stderr → GitErrorKind classification.
 *
 * Pattern shape is "ordered list per kind"; `classifyGitStderr` (in
 * `git-error.ts`) walks the kinds in priority order so the most-specific
 * patterns win. Adding a new kind here is the only place a contributor
 * needs to touch — they do not need to thread the new regex through the
 * classifier wiring.
 *
 * Every regex is case-insensitive on purpose: git's stderr lowercases some
 * tokens but preserves case for paths, branches, and remotes.
 */

export const AUTH_STDERR_PATTERNS = [
  /authentication failed/i,
  /invalid username or password/i,
  /permission denied \(publickey\)/i,
  /permission denied, please try again/i,
];

export const AUTH_REQUIRED_STDERR_PATTERNS = [
  /could not read username/i,
  /could not read password/i,
  /terminal prompts disabled/i,
  /no such device or address/i,
];

export const CONFLICT_STDERR_PATTERNS = [
  /automatic merge failed/i,
  /\bconflict\b/i,
  /fix conflicts and then commit/i,
  /you have unmerged paths/i,
  /unmerged files/i,
  /needs merge/i,
];

export const NOT_REPO_STDERR_PATTERNS = [
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
export const MISSING_STDERR_PATTERNS = [
  /invalid object name/i,
  /pathspec .+ did not match/i,
  /path .+ does not exist in/i,
  /exists on disk, but not in/i,
  /did not match any file/i,
  /unknown revision or path not in the working tree/i,
];

// `.git/index.lock` and friends — race when another git process is mid-write.
// `git-process` retries operations in this category with quadratic backoff.
export const LOCK_BUSY_STDERR_PATTERNS = [
  /another git process seems to be running/i,
  /could not lock config file/i,
  /unable to create '?[^']*\.git\/(index|.*\.lock)'? *: file exists/i,
  /\.lock'?: file exists/i,
  /cannot lock ref/i,
];

// Git refuses to overwrite uncommitted edits during checkout/merge/stash apply.
export const LOCAL_CHANGES_OVERWRITTEN_STDERR_PATTERNS = [
  /your local changes to the following files would be overwritten by (checkout|merge|rebase|stash)/i,
  /please commit your changes or stash them before you (switch|merge|rebase)/i,
];

export const GITIGNORE_WRITE_FAILED_STDERR_PATTERNS = [
  /could not write .*\.gitignore/i,
  /failed to write .*\.gitignore/i,
  /unable to write .*\.gitignore/i,
];

export const COMMIT_ABORTED_STDERR_PATTERNS = [
  /aborting commit due to empty commit message/i,
  /empty commit message/i,
  /commit aborted/i,
  /there was a problem with the editor/i,
  /please supply the message using either -m or -F option/i,
];

export const SIGNING_FAILED_STDERR_PATTERNS = [
  /gpg failed to sign the data/i,
  /failed to sign the commit/i,
  /signing failed/i,
  /couldn'?t load public key/i,
];

export const NO_PARENT_STDERR_PATTERNS = [
  /ambiguous argument ['"]?HEAD\^['"]?/i,
  /bad revision ['"]?HEAD\^['"]?/i,
  /unknown revision.*HEAD\^/i,
];

export const BINARY_TOO_LARGE_STDERR_PATTERNS = [
  /binary file .+ is too large/i,
  /file .+ is too large to display/i,
  /blob .+ exceeds .* limit/i,
];

export const FILE_NOT_IN_HEAD_STDERR_PATTERNS = [
  /path .+ does not exist in ['"]?HEAD['"]?/i,
  /path .+ exists on disk, but not in ['"]?HEAD['"]?/i,
  /fatal: path .+ exists on disk, but not in/i,
];

export const PATH_NOT_IN_REPO_STDERR_PATTERNS = [
  /path .+ is outside repository/i,
  /outside repository/i,
  /not under version control/i,
];

export const STASH_CONFLICT_STDERR_PATTERNS = [
  /conflicts in index\. try without --index/i,
  /could not restore untracked files from stash/i,
  /stash.*conflict/i,
];

export const STASH_NOT_FOUND_STDERR_PATTERNS = [
  /stash@\{\d+\} is not a valid reference/i,
  /log for ['"]?refs\/stash['"]? only has \d+ entries/i,
  /no stash entry found/i,
];

export const EMPTY_COMMIT_STDERR_PATTERNS = [
  /the previous (cherry-pick|revert) is now empty/i,
  /(cherry-pick|revert) is now empty/i,
  /would make\s+it empty/i,
];

export const NOTHING_TO_COMMIT_STDERR_PATTERNS = [
  /nothing to commit/i,
  /no changes added to commit/i,
  /nothing added to commit/i,
];

export const BRANCH_NOT_FULLY_MERGED_STDERR_PATTERNS = [
  /the branch '.+' is not fully merged/i,
  /not fully merged/i,
];

export const BRANCH_CHECKED_OUT_STDERR_PATTERNS = [
  /cannot delete branch '.+' checked out/i,
  /branch '.+' is checked out at/i,
  /is already checked out at/i,
];

export const BRANCH_NAME_INVALID_STDERR_PATTERNS = [
  /not a valid branch name/i,
  /is not a valid name for a branch/i,
  /invalid branch name/i,
];

export const BRANCH_EXISTS_STDERR_PATTERNS = [
  /a branch named '.+' already exists/i,
  /^fatal: A branch named '.+' already exists/im,
];

export const REMOTE_EXISTS_STDERR_PATTERNS = [/remote .+ already exists/i];

export const REMOTE_NAME_INVALID_STDERR_PATTERNS = [
  /'.+' is not a valid remote name/i,
  /invalid remote name/i,
];

export const REMOTE_URL_INVALID_STDERR_PATTERNS = [/invalid url/i, /invalid remote url/i];

export const REMOTE_NOT_FOUND_STDERR_PATTERNS = [/no such remote/i, /remote .+ does not exist/i];

export const TAG_EXISTS_STDERR_PATTERNS = [
  /tag '.+' already exists/i,
  /fatal: tag .+ already exists/i,
];

export const TAG_NOT_FOUND_STDERR_PATTERNS = [
  /tag '.+' not found/i,
  /could not delete ref .*tag/i,
  /unable to delete '.+': remote ref does not exist/i,
];

export const TAG_NAME_INVALID_STDERR_PATTERNS = [
  /not a valid tag name/i,
  /is not a valid tag name/i,
  /invalid tag name/i,
];

export const REF_NOT_FOUND_STDERR_PATTERNS = [
  /failed to resolve '.+' as a valid ref/i,
  /ambiguous argument '.+': unknown revision or path not in the working tree/i,
];

export const UPSTREAM_INVALID_STDERR_PATTERNS = [
  /requested upstream branch '.+' does not exist/i,
  /cannot set up tracking information/i,
  /not stored as a remote-tracking branch/i,
];

export const MERGE_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /you have not concluded your merge/i,
  /merge_head exists/i,
];

export const REBASE_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /rebase-merge directory exists/i,
  /rebase-apply directory exists/i,
  /already a rebase/i,
];

export const CHERRY_PICK_ALREADY_IN_PROGRESS_STDERR_PATTERNS = [
  /cherry-pick is already in progress/i,
  /cherry_pick_head exists/i,
];

export const NO_OPERATION_IN_PROGRESS_STDERR_PATTERNS = [
  /no cherry-pick or revert in progress/i,
  /no rebase in progress/i,
  /there is no merge to abort/i,
  /no operation is in progress/i,
];

export const UNRESOLVED_CONFLICTS_STDERR_PATTERNS = [
  /you need to resolve your current index first/i,
  /committing is not possible because you have unmerged files/i,
  /cannot .* because you have unmerged files/i,
];

export const UNRELATED_HISTORIES_STDERR_PATTERNS = [/refusing to merge unrelated histories/i];

export const NO_MERGE_BASE_STDERR_PATTERNS = [
  /no merge base/i,
  /not possible to fast-forward, aborting/i,
];

export const PATH_NOT_CONFLICTED_STDERR_PATTERNS = [
  /path .+ does not have conflicts/i,
  /path .+ is not conflicted/i,
  /is not an unmerged path/i,
];

export const CLONE_DESTINATION_INVALID_STDERR_PATTERNS = [
  /clone destination .* invalid/i,
  /destination path .* is not absolute/i,
];

export const CLONE_DESTINATION_NOT_WRITABLE_STDERR_PATTERNS = [
  /could not create work tree dir .+ permission denied/i,
  /permission denied.*clone destination/i,
  /destination .+ is not writable/i,
];

export const CLONE_DESTINATION_EXISTS_STDERR_PATTERNS = [
  /destination path '.+' already exists and is not an empty directory/i,
  /destination path .+ already exists/i,
];

export const CLONE_NAME_INVALID_STDERR_PATTERNS = [
  /clone name .* invalid/i,
  /repository name .* invalid/i,
];

export const CLONE_URL_INVALID_STDERR_PATTERNS = [
  /repository '.+' does not exist/i,
  /clone url .* invalid/i,
  /invalid clone url/i,
];

// `git push` was rejected. Force-with-lease rejection is split out so the UI
// can surface a different message ("remote moved — fetch first") vs. an
// ordinary non-fast-forward push rejection.
export const FORCE_PUSH_REJECTED_STDERR_PATTERNS = [/stale info/i];

export const NON_FAST_FORWARD_STDERR_PATTERNS = [
  /non-fast-forward/i,
  /tip of your current branch is behind/i,
  /fetch first/i,
  /remote contains work that you do not have locally/i,
];

export const PROTECTED_BRANCH_STDERR_PATTERNS = [
  /protected branch hook declined/i,
  /\bgh006\b/i,
  /branch .+ is read-only/i,
  /protected branch/i,
];

export const PRE_RECEIVE_HOOK_REJECTED_STDERR_PATTERNS = [
  /pre-receive hook declined/i,
  /pre-receive hook rejected/i,
];

export const PUSH_REJECTED_STDERR_PATTERNS = [
  /\[rejected\]/i,
  /failed to push some refs/i,
  /updates were rejected/i,
];

// Stash apply / pop with no matching changes; commit --amend with no edits.
// Empty-stash gets its own bucket below so the renderer can distinguish
// "you have no work to record" from "the stash stack is empty".
export const NO_LOCAL_CHANGES_STDERR_PATTERNS = [/no local changes to save/i];

export const EMPTY_STASH_STDERR_PATTERNS = [/no stash entries found/i, /\bno stash found\b/i];

export const BRANCH_NOT_MERGED_STDERR_PATTERNS = [/the branch '.+' is not fully merged/i];

// Preflight-aligned stderr matchers — git's actual error text for the same
// situations our preflight catches. Lets us drop redundant preflight calls
// once classification is good enough on its own.
export const NO_HEAD_STDERR_PATTERNS = [
  /you do not have the initial commit yet/i,
  /does not have any commits yet/i,
  /bad default revision 'HEAD'/i,
];

export const NO_UPSTREAM_STDERR_PATTERNS = [
  /there is no tracking information for the current branch/i,
  /no upstream configured for branch/i,
  /the current branch [^ ]+ has no upstream branch/i,
];

export const NO_REMOTE_STDERR_PATTERNS = [
  /no configured push destination/i,
  /'[^']*' does not appear to be a git repository/i,
  /no such remote /i,
  /no remote repository specified/i,
  /no remote configured to list refs/i,
];
