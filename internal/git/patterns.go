package git

import "regexp"

// stderrPatterns holds the compiled regex catalog for one GitErrorKind.
type stderrPatterns []*regexp.Regexp

// mustCompileStderrPatterns compiles a Git stderr regex group at package init.
func mustCompileStderrPatterns(patterns ...string) stderrPatterns {
	compiled := make(stderrPatterns, 0, len(patterns))
	for _, pattern := range patterns {
		compiled = append(compiled, regexp.MustCompile(pattern))
	}
	return compiled
}

// Matches reports whether any regex in the catalog group matches stderr.
func (patterns stderrPatterns) Matches(stderr string) bool {
	for _, pattern := range patterns {
		if pattern.MatchString(stderr) {
			return true
		}
	}
	return false
}

var authStderrPatterns = mustCompileStderrPatterns(
	`(?i)authentication failed`,
	`(?i)invalid username or password`,
	`(?i)permission denied \(publickey\)`,
	`(?i)permission denied, please try again`,
)

var authRequiredStderrPatterns = mustCompileStderrPatterns(
	`(?i)could not read username`,
	`(?i)could not read password`,
	`(?i)terminal prompts disabled`,
	`(?i)no such device or address`,
)

var conflictStderrPatterns = mustCompileStderrPatterns(
	`(?i)automatic merge failed`,
	`(?i)\bconflict\b`,
	`(?i)fix conflicts and then commit`,
	`(?i)you have unmerged paths`,
	`(?i)unmerged files`,
	`(?i)needs merge`,
)

var notRepoStderrPatterns = mustCompileStderrPatterns(
	`(?i)not a git repository`,
	`(?i)no git repository`,
	`(?i)not in a git directory`,
	`(?i)must be run in a work tree`,
)

var missingStderrPatterns = mustCompileStderrPatterns(
	`(?i)invalid object name`,
	`(?i)pathspec .+ did not match`,
	`(?i)path .+ does not exist in`,
	`(?i)exists on disk, but not in`,
	`(?i)did not match any file`,
	`(?i)unknown revision or path not in the working tree`,
)

var lockBusyStderrPatterns = mustCompileStderrPatterns(
	`(?i)another git process seems to be running`,
	`(?i)could not lock config file`,
	`(?i)unable to create '?[^']*\.git/(index|.*\.lock)'? *: file exists`,
	`(?i)\.lock'?: file exists`,
	`(?i)cannot lock ref`,
)

var localChangesOverwrittenStderrPatterns = mustCompileStderrPatterns(
	`(?i)your local changes to the following files would be overwritten by (checkout|merge|rebase|stash)`,
	`(?i)please commit your changes or stash them before you (switch|merge|rebase)`,
)

var gitignoreWriteFailedStderrPatterns = mustCompileStderrPatterns(
	`(?i)could not write .*\.gitignore`,
	`(?i)failed to write .*\.gitignore`,
	`(?i)unable to write .*\.gitignore`,
)

var commitAbortedStderrPatterns = mustCompileStderrPatterns(
	`(?i)aborting commit due to empty commit message`,
	`(?i)empty commit message`,
	`(?i)commit aborted`,
	`(?i)there was a problem with the editor`,
	`(?i)please supply the message using either -m or -F option`,
)

var signingFailedStderrPatterns = mustCompileStderrPatterns(
	`(?i)gpg failed to sign the data`,
	`(?i)failed to sign the commit`,
	`(?i)signing failed`,
	`(?i)couldn'?t load public key`,
)

var noParentStderrPatterns = mustCompileStderrPatterns(
	`(?i)ambiguous argument ['"]?HEAD\^['"]?`,
	`(?i)bad revision ['"]?HEAD\^['"]?`,
	`(?i)unknown revision.*HEAD\^`,
)

var binaryTooLargeStderrPatterns = mustCompileStderrPatterns(
	`(?i)binary file .+ is too large`,
	`(?i)file .+ is too large to display`,
	`(?i)blob .+ exceeds .* limit`,
)

var fileNotInHeadStderrPatterns = mustCompileStderrPatterns(
	`(?i)path .+ does not exist in ['"]?HEAD['"]?`,
	`(?i)path .+ exists on disk, but not in ['"]?HEAD['"]?`,
	`(?i)fatal: path .+ exists on disk, but not in`,
)

var pathNotInRepoStderrPatterns = mustCompileStderrPatterns(
	`(?i)path .+ is outside repository`,
	`(?i)outside repository`,
	`(?i)not under version control`,
)

var stashConflictStderrPatterns = mustCompileStderrPatterns(
	`(?i)conflicts in index\. try without --index`,
	`(?i)could not restore untracked files from stash`,
	`(?i)stash.*conflict`,
)

var stashNotFoundStderrPatterns = mustCompileStderrPatterns(
	`(?i)stash@\{\d+\} is not a valid reference`,
	`(?i)log for ['"]?refs/stash['"]? only has \d+ entries`,
	`(?i)no stash entry found`,
)

var emptyCommitStderrPatterns = mustCompileStderrPatterns(
	`(?i)the previous (cherry-pick|revert) is now empty`,
	`(?i)(cherry-pick|revert) is now empty`,
	`(?i)would make\s+it empty`,
)

var nothingToCommitStderrPatterns = mustCompileStderrPatterns(
	`(?i)nothing to commit`,
	`(?i)no changes added to commit`,
	`(?i)nothing added to commit`,
)

var branchNotFullyMergedStderrPatterns = mustCompileStderrPatterns(
	`(?i)the branch '.+' is not fully merged`,
	`(?i)not fully merged`,
)

var branchCheckedOutStderrPatterns = mustCompileStderrPatterns(
	`(?i)cannot delete branch '.+' checked out`,
	`(?i)branch '.+' is checked out at`,
	`(?i)is already checked out at`,
)

var branchNameInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)not a valid branch name`,
	`(?i)is not a valid name for a branch`,
	`(?i)invalid branch name`,
)

var branchExistsStderrPatterns = mustCompileStderrPatterns(
	`(?i)a branch named '.+' already exists`,
	`(?im)^fatal: A branch named '.+' already exists`,
)

var remoteExistsStderrPatterns = mustCompileStderrPatterns(
	`(?i)remote .+ already exists`,
)

var remoteNameInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)'.+' is not a valid remote name`,
	`(?i)invalid remote name`,
)

var remoteURLInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)invalid url`,
	`(?i)invalid remote url`,
)

var remoteNotFoundStderrPatterns = mustCompileStderrPatterns(
	`(?i)no such remote`,
	`(?i)remote .+ does not exist`,
)

var tagExistsStderrPatterns = mustCompileStderrPatterns(
	`(?i)tag '.+' already exists`,
	`(?i)fatal: tag .+ already exists`,
)

var tagNotFoundStderrPatterns = mustCompileStderrPatterns(
	`(?i)tag '.+' not found`,
	`(?i)could not delete ref .*tag`,
	`(?i)unable to delete '.+': remote ref does not exist`,
)

var tagNameInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)not a valid tag name`,
	`(?i)is not a valid tag name`,
	`(?i)invalid tag name`,
)

var refNotFoundStderrPatterns = mustCompileStderrPatterns(
	`(?i)failed to resolve '.+' as a valid ref`,
	`(?i)ambiguous argument '.+': unknown revision or path not in the working tree`,
)

var upstreamInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)requested upstream branch '.+' does not exist`,
	`(?i)cannot set up tracking information`,
	`(?i)not stored as a remote-tracking branch`,
)

var mergeAlreadyInProgressStderrPatterns = mustCompileStderrPatterns(
	`(?i)you have not concluded your merge`,
	`(?i)merge_head exists`,
)

var rebaseAlreadyInProgressStderrPatterns = mustCompileStderrPatterns(
	`(?i)rebase-merge directory exists`,
	`(?i)rebase-apply directory exists`,
	`(?i)already a rebase`,
)

var cherryPickAlreadyInProgressStderrPatterns = mustCompileStderrPatterns(
	`(?i)cherry-pick is already in progress`,
	`(?i)cherry_pick_head exists`,
)

var noOperationInProgressStderrPatterns = mustCompileStderrPatterns(
	`(?i)no cherry-pick or revert in progress`,
	`(?i)no rebase in progress`,
	`(?i)there is no merge to abort`,
	`(?i)no operation is in progress`,
)

var unresolvedConflictsStderrPatterns = mustCompileStderrPatterns(
	`(?i)you need to resolve your current index first`,
	`(?i)committing is not possible because you have unmerged files`,
	`(?i)cannot .* because you have unmerged files`,
)

var unrelatedHistoriesStderrPatterns = mustCompileStderrPatterns(
	`(?i)refusing to merge unrelated histories`,
)

var noMergeBaseStderrPatterns = mustCompileStderrPatterns(
	`(?i)no merge base`,
	`(?i)not possible to fast-forward, aborting`,
)

var pathNotConflictedStderrPatterns = mustCompileStderrPatterns(
	`(?i)path .+ does not have conflicts`,
	`(?i)path .+ is not conflicted`,
	`(?i)is not an unmerged path`,
)

var cloneDestinationInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)clone destination .* invalid`,
	`(?i)destination path .* is not absolute`,
)

var cloneDestinationNotWritableStderrPatterns = mustCompileStderrPatterns(
	`(?i)could not create work tree dir .+ permission denied`,
	`(?i)permission denied.*clone destination`,
	`(?i)destination .+ is not writable`,
)

var cloneDestinationExistsStderrPatterns = mustCompileStderrPatterns(
	`(?i)destination path '.+' already exists and is not an empty directory`,
	`(?i)destination path .+ already exists`,
)

var cloneNameInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)clone name .* invalid`,
	`(?i)repository name .* invalid`,
)

var cloneURLInvalidStderrPatterns = mustCompileStderrPatterns(
	`(?i)repository '.+' does not exist`,
	`(?i)clone url .* invalid`,
	`(?i)invalid clone url`,
)

var forcePushRejectedStderrPatterns = mustCompileStderrPatterns(
	`(?i)stale info`,
)

var nonFastForwardStderrPatterns = mustCompileStderrPatterns(
	`(?i)non-fast-forward`,
	`(?i)tip of your current branch is behind`,
	`(?i)fetch first`,
	`(?i)remote contains work that you do not have locally`,
)

var protectedBranchStderrPatterns = mustCompileStderrPatterns(
	`(?i)protected branch hook declined`,
	`(?i)\bgh006\b`,
	`(?i)branch .+ is read-only`,
	`(?i)protected branch`,
)

var preReceiveHookRejectedStderrPatterns = mustCompileStderrPatterns(
	`(?i)pre-receive hook declined`,
	`(?i)pre-receive hook rejected`,
)

var pushRejectedStderrPatterns = mustCompileStderrPatterns(
	`(?i)\[rejected\]`,
	`(?i)failed to push some refs`,
	`(?i)updates were rejected`,
)

var noLocalChangesStderrPatterns = mustCompileStderrPatterns(
	`(?i)no local changes to save`,
)

var emptyStashStderrPatterns = mustCompileStderrPatterns(
	`(?i)no stash entries found`,
	`(?i)\bno stash found\b`,
)

var branchNotMergedStderrPatterns = mustCompileStderrPatterns(
	`(?i)the branch '.+' is not fully merged`,
)

var noHeadStderrPatterns = mustCompileStderrPatterns(
	`(?i)you do not have the initial commit yet`,
	`(?i)does not have any commits yet`,
	`(?i)bad default revision 'HEAD'`,
)

var noUpstreamStderrPatterns = mustCompileStderrPatterns(
	`(?i)there is no tracking information for the current branch`,
	`(?i)no upstream configured for branch`,
	`(?i)the current branch [^ ]+ has no upstream branch`,
)

var noRemoteStderrPatterns = mustCompileStderrPatterns(
	`(?i)no configured push destination`,
	`(?i)'[^']*' does not appear to be a git repository`,
	`(?i)no such remote `,
	`(?i)no remote repository specified`,
	`(?i)no remote configured to list refs`,
)
