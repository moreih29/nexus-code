/**
 * Renderer-only diff ref constants.
 *
 * EMPTY_TREE is used as the leftRef sentinel for staged and default-group
 * diffs in unborn repositories (BranchInfo.isUnborn=true). When
 * diff-content-loader sees this ref it returns empty content immediately
 * without issuing a git.getFileContent IPC call, avoiding the
 * "fatal: invalid object name HEAD" error that git emits before the first
 * commit exists.
 *
 * This module must not be imported from main-process or shared code.
 */

/** Sentinel ref meaning "the empty tree" — no IPC call is issued for this ref. */
export const EMPTY_TREE = "EMPTY_TREE" as const;
