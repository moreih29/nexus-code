/**
 * Branch-operation helpers for GitRepository.
 *
 * GitRepository owns queueing, cancellation, and helper environment setup.
 * This module owns the branch/ref argv construction and result parsing so the
 * repository class stays a thin coordinator instead of absorbing every branch
 * management command.
 */
import type { BranchList, GitActionHint, GitFastForwardResult } from "../../shared/types/git";
import { GitError } from "./git-error";
import { resolveCheckoutTarget } from "./git-preflight";
import type { RunGitResult } from "../bridge/git/types";
import type { BuildHelperEnvOptions } from "./helpers-launcher";

export interface GitBranchOpsRunner {
  readonly run: (args: readonly string[]) => Promise<RunGitResult>;
  readonly runWithHelpers: (
    args: readonly string[],
    helpers: BuildHelperEnvOptions,
  ) => Promise<RunGitResult>;
  readonly listBranches: () => Promise<BranchList>;
}

export interface CreateBranchOptions {
  readonly checkout?: boolean;
  readonly fromRef?: string;
}

/**
 * Deletes a local branch, adding the force-delete hint when Git reports that
 * the branch is not fully merged.
 */
export async function deleteBranch(
  git: GitBranchOpsRunner,
  name: string,
  force = false,
): Promise<void> {
  const branchName = normalizeRequiredBranchName(name);
  try {
    await git.run(["branch", force ? "-D" : "-d", branchName]);
  } catch (error) {
    throw withBranchDeleteHint(error, branchName);
  }
}

/**
 * Deletes a remote branch through push so the askpass-capable helper flow can
 * satisfy HTTPS/SSH prompts when a remote requires authentication.
 */
export async function deleteRemoteBranch(
  git: GitBranchOpsRunner,
  remote: string,
  name: string,
): Promise<void> {
  const remoteName = normalizeRequiredRemoteName(remote);
  const branchName = normalizeRequiredBranchName(name);
  await git.runWithHelpers(["push", remoteName, "--delete", branchName], { askpass: true });
}

/**
 * Renames a local branch. Git's own validation and conflict messages are kept
 * so the stderr classifier can surface branch-name-invalid / branch-exists.
 */
export async function renameBranch(
  git: GitBranchOpsRunner,
  from: string,
  to: string,
): Promise<void> {
  await git.run([
    "branch",
    "-m",
    normalizeRequiredBranchName(from),
    normalizeRequiredBranchName(to),
  ]);
}

/**
 * Sets or unsets a branch upstream. Passing null maps to --unset-upstream and
 * a string maps to --set-upstream-to so invalid refs classify as upstream-invalid.
 */
export async function setUpstream(
  git: GitBranchOpsRunner,
  branch: string,
  upstream: string | null,
): Promise<void> {
  const branchName = normalizeRequiredBranchName(branch);
  if (upstream === null) {
    await git.run(["branch", "--unset-upstream", branchName]);
    return;
  }
  const upstreamName = normalizeRequiredUpstream(upstream);
  await git.run(["branch", "--set-upstream-to", upstreamName, branchName]);
}

/**
 * Fast-forwards a local branch from one remote ref and reports whether the
 * branch SHA advanced. Non-current branches use Git's refspec update form.
 * The checked-out branch cannot be updated by fetch directly, so it fetches
 * the remote ref into FETCH_HEAD and then performs an ff-only merge.
 */
export async function fastForwardBranch(
  git: GitBranchOpsRunner,
  branch: string,
  remote: string,
  remoteRef: string,
): Promise<GitFastForwardResult> {
  const branchName = normalizeRequiredBranchName(branch);
  const remoteName = normalizeRequiredRemoteName(remote);
  const fetchRef = normalizeFetchRemoteRef(remoteName, remoteRef);
  const fromSha = await revParse(git, branchName);
  const currentBranch = await readCurrentBranch(git);

  if (currentBranch === branchName) {
    await git.runWithHelpers(["fetch", remoteName, fetchRef], { askpass: true });
    await git.run(["merge", "--ff-only", "FETCH_HEAD"]);
  } else {
    await git.runWithHelpers(["fetch", remoteName, `${fetchRef}:refs/heads/${branchName}`], {
      askpass: true,
    });
  }

  const toSha = await revParse(git, branchName);
  return { advanced: fromSha !== toSha, fromSha, toSha };
}

/**
 * Creates a branch, optionally at a provided start ref and optionally checking
 * the new branch out immediately. Remote branch short names are resolved with
 * the existing checkout preflight helper; tags and commit SHAs fall through to
 * Git's object resolver.
 */
export async function createBranch(
  git: GitBranchOpsRunner,
  name: string,
  options: CreateBranchOptions = {},
): Promise<void> {
  const branchName = normalizeRequiredBranchName(name);
  const startPoint = options.fromRef
    ? await resolveCreateBranchStartPoint(git, options.fromRef)
    : undefined;

  const args = options.checkout ? ["checkout", "-b", branchName] : ["branch", branchName];
  if (startPoint) args.push(startPoint);
  await git.run(args);
}

/**
 * Resolves the branch start point while preserving tag/SHA support.
 */
async function resolveCreateBranchStartPoint(
  git: GitBranchOpsRunner,
  fromRef: string,
): Promise<string> {
  const trimmed = fromRef.trim();
  if (trimmed.length === 0) throw new GitError("no-such-ref", "Create-from ref is required.");

  const branches = await git.listBranches();
  try {
    const target = resolveCheckoutTarget(trimmed, branches);
    return target.kind === "local" ? target.ref : target.remoteRef;
  } catch (error) {
    if (error instanceof GitError && error.hint?.kind === "ambiguous-remote") {
      throw error;
    }
    return trimmed;
  }
}

/**
 * Reads a single commit SHA for a branch/ref after --verify validation.
 */
async function revParse(git: GitBranchOpsRunner, ref: string): Promise<string> {
  const { stdout } = await git.run(["rev-parse", "--verify", ref]);
  return stdout.trim();
}

/**
 * Returns the checked-out branch, or null when HEAD is detached/unborn.
 */
async function readCurrentBranch(git: GitBranchOpsRunner): Promise<string | null> {
  try {
    const { stdout } = await git.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return stdout.trim() || null;
  } catch (error) {
    if (error instanceof GitError && (error.kind === "unknown" || error.kind === "missing")) {
      return null;
    }
    return null;
  }
}

/**
 * Rewrites the non-fully-merged delete error with a branch-specific hint.
 */
function withBranchDeleteHint(error: unknown, branch: string): unknown {
  if (!(error instanceof GitError) || error.kind !== "branch-not-fully-merged") return error;
  return new GitError("branch-not-fully-merged", error.message, {
    argv: error.argv,
    stderr: error.stderr,
    stdout: error.stdout,
    exitCode: error.exitCode,
    signal: error.signal,
    cause: error,
    hint: { kind: "force-delete-available", branch } satisfies GitActionHint,
  });
}

/**
 * Normalizes branch names before passing them as argv atoms.
 */
function normalizeRequiredBranchName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new GitError("branch-name-invalid", "Branch name is required.");
  return trimmed;
}

/**
 * Normalizes remote names before push/fetch operations.
 */
function normalizeRequiredRemoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new GitError("no-remote", "Remote name is required.");
  return trimmed;
}

/**
 * Normalizes upstream refs before passing them to --set-upstream-to.
 */
function normalizeRequiredUpstream(upstream: string): string {
  const trimmed = upstream.trim();
  if (trimmed.length === 0) throw new GitError("upstream-invalid", "Upstream is required.");
  return trimmed;
}

/**
 * Converts an upstream-style ref such as origin/main into the remote-side ref
 * name accepted by `git fetch <remote> <remoteRef>`.
 */
function normalizeFetchRemoteRef(remote: string, remoteRef: string): string {
  const trimmed = remoteRef.trim();
  if (trimmed.length === 0) throw new GitError("no-such-ref", "Remote ref is required.");
  if (trimmed.startsWith("refs/")) return trimmed;
  const prefix = `${remote}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}
