/**
 * Conflict-resolution helpers for workflow operations.
 *
 * Marking a file resolved is intentionally separate from generic staging:
 * callers get conflict-specific validation and a remaining-conflicts count
 * suitable for the operation banner.
 */
import path from "node:path";
import type { GitMarkResolvedResult, GitStatus } from "../../shared/types/git";
import { GitError } from "./git-error";
import type { RunGitResult } from "./git-process";

export interface GitConflictRunner {
  readonly topLevel: string;
  readonly run: (args: readonly string[]) => Promise<RunGitResult>;
  readonly readStatus: () => Promise<GitStatus>;
}

/**
 * Validates that every requested path is currently conflicted, then stages the
 * paths and returns the remaining conflict count.
 */
export async function markResolved(
  git: GitConflictRunner,
  relPaths: readonly string[],
): Promise<GitMarkResolvedResult> {
  const normalizedPaths = normalizeRepoPaths(git.topLevel, relPaths);
  const status = await git.readStatus();
  const conflictedPaths = collectConflictedPaths(status);

  for (const relPath of normalizedPaths) {
    if (!conflictedPaths.has(relPath)) {
      throw new GitError("path-not-conflicted", `Path is not conflicted: ${relPath}`);
    }
  }

  await git.run(["add", "--", ...normalizedPaths]);
  const refreshed = await git.readStatus();
  return { remainingConflicts: refreshed.merge.length };
}

/**
 * Builds a normalized POSIX-ish repository-relative path list and rejects
 * absolute/outside paths before they reach `git add --`.
 */
function normalizeRepoPaths(topLevel: string, relPaths: readonly string[]): string[] {
  const repoRoot = path.resolve(topLevel);
  return relPaths.map((relPath) => normalizeRepoPath(repoRoot, relPath));
}

/**
 * Normalizes one path relative to the repository root.
 */
function normalizeRepoPath(repoRoot: string, relPath: string): string {
  const trimmed = relPath.trim();
  if (trimmed.length === 0 || path.isAbsolute(trimmed)) {
    throw new GitError("path-not-in-repo", `Path is not inside the repository: ${relPath}`);
  }

  const absolutePath = path.resolve(repoRoot, trimmed);
  const normalizedRelPath = path.relative(repoRoot, absolutePath);
  if (
    normalizedRelPath === "" ||
    normalizedRelPath.startsWith("..") ||
    path.isAbsolute(normalizedRelPath)
  ) {
    throw new GitError("path-not-in-repo", `Path is not inside the repository: ${relPath}`);
  }

  return normalizedRelPath.split(path.sep).join("/");
}

/**
 * Collects the repository-relative paths Git currently reports as unmerged.
 */
function collectConflictedPaths(status: GitStatus): Set<string> {
  const conflicted = new Set<string>();
  for (const entry of status.merge) {
    conflicted.add(entry.relPath);
    if (entry.oldRelPath) conflicted.add(entry.oldRelPath);
  }
  return conflicted;
}
