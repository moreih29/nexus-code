/**
 * Helpers used by the `GitRepository` class but kept outside it so the class
 * body stays focused on the queued public API. None of these allocate IO of
 * their own — argv builders return strings, output parsers operate on
 * already-captured stdout/stderr, and the discard planner produces sets the
 * caller turns into Git commands.
 *
 * Anything that needs to await the git executor or stream stdout lives on the class.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  BranchInfo,
  BranchList,
  DiffSpec,
  GitActionHint,
  GitStatus,
  GitStatusEntry,
  GitSyncError,
  PullResult,
  PushResult,
} from "../../shared/types/git";
import { GitError } from "./git-error";
import type { RunGitResult } from "../bridge/git/types";
import type { CommitCommandOptions, DiscardOptions, DiscardPathsets } from "./git-repository";

/**
 * Builds `git diff` arguments from the shared diff spec union.
 */
export function buildDiffArgs(spec: DiffSpec): string[] {
  const args = ["diff", "--no-ext-diff"];

  if (spec.kind === "index-vs-head") {
    args.push("--cached");
  } else if (spec.kind === "wt-vs-head") {
    args.push("HEAD");
  } else if (spec.kind === "ref-vs-ref") {
    args.push(spec.leftRef, spec.rightRef);
  }

  const pathspecs = collectDiffPathspecs(spec);
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }

  return args;
}

/**
 * Returns every path needed to show a rename-aware diff.
 */
function collectDiffPathspecs(spec: DiffSpec): string[] {
  const paths = new Set<string>();
  if (spec.oldRelPath) paths.add(spec.oldRelPath);
  if (spec.relPath) paths.add(spec.relPath);
  return Array.from(paths);
}

/**
 * Builds the commit-family argv, keeping option flags before the message so
 * `--amend`, `--allow-empty`, signing, signoff, and hook-skipping compose.
 */
export function buildCommitArgs(
  message: string | undefined,
  options: CommitCommandOptions,
): string[] {
  const trimmed = message?.trim();
  if (!options.edit && (!trimmed || trimmed.length === 0)) {
    throw new GitError("commit-aborted", "Commit message is required.");
  }

  const args = ["commit"];
  if (options.amend) args.push("--amend");
  if (options.allowEmpty) args.push("--allow-empty");
  if (options.sign) args.push("-S");
  if (options.signoff) args.push("--signoff");
  if (options.noVerify) args.push("--no-verify");
  if (options.edit) {
    args.push("-e");
  } else if (trimmed) {
    args.push("-m", trimmed);
  }
  return args;
}

/**
 * Converts branch command stdout into non-empty branch names.
 */
export function parseBranchLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Summarizes successful `git pull` output for renderer banners.
 */
export function parsePullResult(result: RunGitResult): PullResult {
  const summary = summarizeGitOutput(result);
  const stats = parseDiffStat(summary);
  return {
    alreadyUpToDate: /already up[ -]to[ -]date/i.test(summary),
    fastForward: /fast-forward/i.test(summary) || undefined,
    ...stats,
    summary: summary || undefined,
  };
}

/**
 * Reads `.git/FETCH_HEAD` mtime so external terminal fetches update the chip.
 */
export async function readFetchHeadMtime(gitDir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(gitDir, "FETCH_HEAD"));
    return Math.trunc(stat.mtimeMs);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Identifies a missing FETCH_HEAD without suppressing other filesystem errors.
 */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Detects the standard AbortError shape emitted by the IPC cancellation path.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Copies the stable, renderer-facing subset of a pull GitError into the sync
 * envelope. The full Error instance stays main-process-only; sync needs only
 * enough detail to preserve the existing inline banner copy.
 */
export function gitSyncErrorFromGitError(error: GitError): GitSyncError {
  return {
    kind: error.kind,
    message: error.message,
    ...(error.stderr ? { details: error.stderr } : {}),
  };
}

/**
 * Summarizes successful `git push` output for renderer banners.
 */
export function parsePushResult(result: RunGitResult): PushResult {
  const summary = summarizeGitOutput(result);
  return {
    pushed: !/everything up[ -]to[ -]date/i.test(summary),
    summary: summary || undefined,
  };
}

/**
 * Joins stdout and stderr because Git reports network progress on stderr.
 */
function summarizeGitOutput(result: RunGitResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * Extracts the common `N files changed, X insertions, Y deletions` summary.
 */
function parseDiffStat(
  summary: string,
): Pick<PullResult, "filesChanged" | "insertions" | "deletions"> {
  const stats: Pick<PullResult, "filesChanged" | "insertions" | "deletions"> = {};
  const files = /(\d+) files? changed/.exec(summary);
  const insertions = /(\d+) insertions?\(\+\)/.exec(summary);
  const deletions = /(\d+) deletions?\(-\)/.exec(summary);

  if (files) stats.filesChanged = Number(files[1]);
  if (insertions) stats.insertions = Number(insertions[1]);
  if (deletions) stats.deletions = Number(deletions[1]);
  return stats;
}

/**
 * Computes the git commands needed to discard selected status entries.
 */
export function collectDiscardPathsets(
  status: GitStatus,
  relPaths: readonly string[],
  options: DiscardOptions,
): DiscardPathsets {
  const selected = new Set(relPaths);
  const restoreAllPaths = new Set<string>();
  const restoreWorktreePaths = new Set<string>();
  const resetIndexPaths = new Set<string>();
  const resetThenCleanPaths = new Set<string>();
  const cleanPaths = new Set<string>();
  const source = options.source;

  if (!source || source === "staged") {
    for (const entry of status.staged) {
      if (!entryIsSelected(entry, selected)) continue;
      const stagedCode = entry.xy[0];

      if (source === "staged") {
        resetIndexPaths.add(entry.relPath);
        if (entry.oldRelPath) resetIndexPaths.add(entry.oldRelPath);
        continue;
      }

      if (stagedCode === "A" || stagedCode === "C") {
        resetThenCleanPaths.add(entry.relPath);
        continue;
      }
      restoreAllPaths.add(entry.relPath);
      if (stagedCode === "R" && entry.oldRelPath) restoreAllPaths.add(entry.oldRelPath);
    }
  }

  if (!source || source === "working") {
    for (const entry of status.working) {
      if (!entryIsSelected(entry, selected)) continue;
      if (source === "working") {
        restoreWorktreePaths.add(entry.relPath);
        if (entry.oldRelPath) restoreWorktreePaths.add(entry.oldRelPath);
        continue;
      }

      restoreAllPaths.add(entry.relPath);
      if (entry.xy[0] === "R" && entry.oldRelPath) restoreAllPaths.add(entry.oldRelPath);
    }
  }

  if (!source || source === "merge") {
    for (const entry of status.merge) {
      if (!entryIsSelected(entry, selected)) continue;
      restoreAllPaths.add(entry.relPath);
    }
  }

  if (!source || source === "untracked") {
    for (const entry of status.untracked) {
      if (selected.has(entry.relPath)) cleanPaths.add(entry.relPath);
    }
  }

  return {
    restoreAllPaths: Array.from(restoreAllPaths),
    restoreWorktreePaths: Array.from(restoreWorktreePaths),
    resetIndexPaths: Array.from(resetIndexPaths),
    resetThenCleanPaths: Array.from(resetThenCleanPaths),
    cleanPaths: Array.from(cleanPaths).filter((path) => !resetThenCleanPaths.has(path)),
  };
}

/**
 * Matches a row by new or old path so rename rows can be selected once.
 */
function entryIsSelected(entry: GitStatusEntry, selected: Set<string>): boolean {
  return selected.has(entry.relPath) || (entry.oldRelPath ? selected.has(entry.oldRelPath) : false);
}

/**
 * Throws the standard abort error shape before spawning or streaming Git.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw createAbortError();
}

/**
 * Creates the standard AbortError shape used across queued repository ops.
 */
export function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Keeps queue tails non-rejecting without allocating inline callbacks repeatedly.
 */
export function noop(): void {}

/**
 * Throws when the repository has no commits yet (`git init` without a
 * commit). Used by `push --publish` to fail fast before building a `-u <remote>
 * <branch>` argv with no branch name; the operation could only fail
 * downstream anyway, but doing it here gives the renderer a typed hint.
 */
export function assertHasHead(branch: BranchInfo | null): void {
  if (branch && !branch.isUnborn) return;
  throw new GitError("no-head", "Repository has no commits yet — make an initial commit first.", {
    hint: { kind: "make-initial-commit" } satisfies GitActionHint,
  });
}

/**
 * Resolution emitted by `resolveCheckoutTarget` so the caller can dispatch
 * to the right git command without a second round of branch lookup.
 */
export type CheckoutResolution =
  | { kind: "local"; ref: string }
  | { kind: "track"; remoteRef: string };

/**
 * Decides how to run a checkout when the user supplies a bare ref. If the
 * ref matches a local branch, the caller runs `git checkout <ref>`; if it
 * is unique to one remote (`<remote>/<ref>`), the caller runs `git checkout
 * --track <remoteRef>` so a tracking branch lands deterministically. When
 * the ref is missing entirely or appears under multiple remotes, this
 * throws a `no-such-ref` error with a hint that lets the renderer offer
 * either "Checkout origin/<ref>" or a remote chooser.
 *
 * The function does not match against tags or commit-ish — those still go
 * through `git` directly and surface as `missing` if not resolvable.
 */
export function resolveCheckoutTarget(ref: string, list: BranchList): CheckoutResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new GitError("no-such-ref", "Checkout ref is required.");
  }

  if (list.local.includes(trimmed)) {
    return { kind: "local", ref: trimmed };
  }

  const remoteMatches = list.remote.filter((full) => stripRemotePrefix(full) === trimmed);

  if (remoteMatches.length === 1) {
    return { kind: "track", remoteRef: remoteMatches[0] };
  }

  if (remoteMatches.length > 1) {
    throw new GitError("no-such-ref", `'${trimmed}' is ambiguous — multiple remotes provide it.`, {
      hint: {
        kind: "ambiguous-remote",
        candidates: remoteMatches,
      } satisfies GitActionHint,
    });
  }

  throw new GitError("no-such-ref", `Branch '${trimmed}' does not exist locally or on any remote.`);
}

/**
 * Strips the `<remote>/` segment from a `git branch --remotes` short ref.
 * Mirrors the helper in branch-picker-source.ts; duplicated here to keep
 * this module main-process pure (no renderer imports).
 */
function stripRemotePrefix(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
}
