/**
 * Git workflow operations for merge, rebase, cherry-pick, abort, and continue.
 *
 * GitRepository owns queueing and process wiring; this module owns workflow
 * state dispatch and result-envelope semantics. Conflict-producing start and
 * continue commands return success envelopes so IPC callers can render the
 * conflict UI without treating conflicts as transport failures.
 */
import type {
  GitCherryPickResult,
  GitContinueOpResult,
  GitMergeMode,
  GitMergeResult,
  GitOperationState,
  GitRebaseResult,
  GitStatus,
} from "../../shared/types/git";
import { GitError, isConflictStderr } from "./git-error";
import type { RunGitResult } from "./git-process";

export interface GitWorkflowRunner {
  readonly run: (args: readonly string[]) => Promise<RunGitResult>;
  readonly readStatus: () => Promise<GitStatus>;
  readonly readOperationState: () => Promise<GitOperationState>;
}

/**
 * Starts a merge and returns a clean/conflicts result instead of throwing for
 * normal conflict exits.
 */
export async function merge(
  git: GitWorkflowRunner,
  branch: string,
  mode: GitMergeMode,
): Promise<GitMergeResult> {
  await assertNoOperationInProgress(git);

  try {
    await git.run(buildMergeArgs(branch, mode));
    return { result: "clean" };
  } catch (error) {
    return handleMergeConflictExit(git, error);
  }
}

/**
 * Starts a non-interactive rebase onto one ref and returns rebase progress
 * counters when Git pauses on conflicts.
 */
export async function rebase(git: GitWorkflowRunner, onto: string): Promise<GitRebaseResult> {
  await assertNoOperationInProgress(git);

  const totalCount = await countRebaseCommits(git, onto);
  try {
    await git.run(["rebase", normalizeRequiredRef(onto)]);
    return {
      result: "clean",
      conflictCount: 0,
      doneCount: totalCount,
      totalCount,
    };
  } catch (error) {
    return handleRebaseConflictExit(git, error);
  }
}

/**
 * Cherry-picks one commit and returns conflict exits as success envelopes.
 */
export async function cherryPick(
  git: GitWorkflowRunner,
  sha: string,
): Promise<GitCherryPickResult> {
  await assertNoOperationInProgress(git);

  try {
    await git.run(["cherry-pick", normalizeRequiredRef(sha)]);
    return { result: "clean" };
  } catch (error) {
    return handleCherryPickConflictExit(git, error);
  }
}

/**
 * Aborts the workflow operation currently recorded on disk.
 */
export async function abortOp(git: GitWorkflowRunner): Promise<void> {
  const state = await git.readOperationState();
  switch (state.kind) {
    case "none":
      throw new GitError("no-operation-in-progress", "No Git operation is in progress.");
    case "merge":
      await git.run(["merge", "--abort"]);
      return;
    case "rebase":
      await git.run(["rebase", "--abort"]);
      return;
    case "cherry-pick":
      await git.run(["cherry-pick", "--abort"]);
      return;
    case "revert":
      await git.run(["revert", "--abort"]);
      return;
  }
}

/**
 * Continues the workflow operation currently recorded on disk.
 */
export async function continueOp(git: GitWorkflowRunner): Promise<GitContinueOpResult> {
  const state = await git.readOperationState();
  if (state.kind === "none") {
    throw new GitError("no-operation-in-progress", "No Git operation is in progress.");
  }
  if (state.conflictCount > 0) {
    throw new GitError("unresolved-conflicts", "Resolve conflicts before continuing.");
  }

  try {
    await git.run(buildContinueArgs(state));
  } catch (error) {
    return handleContinueConflictExit(git, error);
  }

  return continueResultFromState(await git.readOperationState());
}

/**
 * Builds argv for merge modes surfaced by the renderer.
 */
function buildMergeArgs(branch: string, mode: GitMergeMode): string[] {
  const normalizedBranch = normalizeRequiredRef(branch);
  switch (mode) {
    case "default":
      return ["merge", "--no-edit", normalizedBranch];
    case "no-ff":
      return ["merge", "--no-ff", "--no-edit", normalizedBranch];
    case "squash":
      return ["merge", "--squash", normalizedBranch];
  }
}

/**
 * Builds the continuation command for the active workflow kind.
 */
function buildContinueArgs(state: Exclude<GitOperationState, { kind: "none" }>): string[] {
  switch (state.kind) {
    case "merge":
      return ["commit", "--no-edit"];
    case "rebase":
      return ["rebase", "--continue"];
    case "cherry-pick":
      return ["cherry-pick", "--continue"];
    case "revert":
      return ["revert", "--continue"];
  }
}

/**
 * Converts a post-continue disk state into the public result envelope.
 */
function continueResultFromState(state: GitOperationState): GitContinueOpResult {
  if (state.kind === "none") return { result: "completed" };
  if (state.conflictCount > 0) {
    return { result: "conflicts", conflictCount: state.conflictCount };
  }
  return { result: "clean", conflictCount: 0 };
}

/**
 * Throws the operation-specific "already in progress" error when any workflow
 * marker is present before a new workflow starts.
 */
async function assertNoOperationInProgress(git: GitWorkflowRunner): Promise<void> {
  const state = await git.readOperationState();
  if (state.kind === "none") return;
  throw alreadyInProgressError(state);
}

/**
 * Creates a stable typed error for the active operation kind.
 */
function alreadyInProgressError(state: Exclude<GitOperationState, { kind: "none" }>): GitError {
  switch (state.kind) {
    case "merge":
      return new GitError("merge-already-in-progress", "A merge is already in progress.");
    case "rebase":
      return new GitError("rebase-already-in-progress", "A rebase is already in progress.");
    case "cherry-pick":
      return new GitError(
        "cherry-pick-already-in-progress",
        "A cherry-pick is already in progress.",
      );
    case "revert":
      return new GitError("unresolved-conflicts", "A revert is already in progress.");
  }
}

/**
 * Handles merge conflict exits, preserving all non-conflict failures.
 */
async function handleMergeConflictExit(
  git: GitWorkflowRunner,
  error: unknown,
): Promise<GitMergeResult> {
  if (!isWorkflowConflictError(error)) throw error;
  const status = await git.readStatus();
  if (status.merge.length === 0) throw error;
  return { result: "conflicts", conflictCount: status.merge.length };
}

/**
 * Handles rebase conflict exits, preserving all non-conflict failures.
 */
async function handleRebaseConflictExit(
  git: GitWorkflowRunner,
  error: unknown,
): Promise<GitRebaseResult> {
  if (!isWorkflowConflictError(error)) throw error;
  const state = await git.readOperationState();
  if (state.kind === "rebase" && state.conflictCount > 0) {
    return {
      result: "conflicts",
      conflictCount: state.conflictCount,
      doneCount: state.doneCount,
      totalCount: state.totalCount,
    };
  }
  throw error;
}

/**
 * Handles cherry-pick conflict exits, preserving all non-conflict failures.
 */
async function handleCherryPickConflictExit(
  git: GitWorkflowRunner,
  error: unknown,
): Promise<GitCherryPickResult> {
  if (!isWorkflowConflictError(error)) throw error;
  const status = await git.readStatus();
  if (status.merge.length === 0) throw error;
  return { result: "conflicts", conflictCount: status.merge.length };
}

/**
 * Handles continue commands that immediately hit the next conflict.
 */
async function handleContinueConflictExit(
  git: GitWorkflowRunner,
  error: unknown,
): Promise<GitContinueOpResult> {
  if (!isWorkflowConflictError(error)) throw error;
  const state = await git.readOperationState();
  if (state.kind !== "none" && state.conflictCount > 0) {
    return { result: "conflicts", conflictCount: state.conflictCount };
  }
  throw error;
}

/**
 * Counts commits that a rebase would replay. Invalid refs fall through to the
 * real `git rebase` command so its stderr classifier owns the final error.
 */
async function countRebaseCommits(git: GitWorkflowRunner, onto: string): Promise<number> {
  try {
    const { stdout } = await git.run([
      "rev-list",
      "--count",
      `${normalizeRequiredRef(onto)}..HEAD`,
    ]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Identifies Git failures that mean "operation paused for conflict" rather
 * than "operation failed".
 */
function isWorkflowConflictError(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  if (error.kind === "conflict" || error.kind === "unresolved-conflicts") return true;
  return isConflictStderr([error.stderr, error.stdout].filter(Boolean).join("\n"));
}

/**
 * Normalizes required branch/commit refs while preserving Git's own semantic
 * validation for invalid names.
 */
function normalizeRequiredRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) throw new GitError("no-such-ref", "Git ref is required.");
  return trimmed;
}
