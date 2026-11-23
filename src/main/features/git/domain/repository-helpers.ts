import fs from "node:fs/promises";
import path from "node:path";

export { createAbortError, isAbortError, throwIfAborted } from "../../../../shared/abort";

import type {
  BranchInfo,
  BranchList,
  DiffSpec,
  GitActionHint,
  GitStatus,
  GitStatusEntry,
  GitSyncError,
} from "../../../../shared/git/types";
import { GitError } from "./error";
import type { CommitCommandOptions, DiscardOptions, DiscardPathsets } from "./repository";

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
    args.unshift("--literal-pathspecs");
    args.push("--", ...pathspecs);
  }

  return args;
}

function collectDiffPathspecs(spec: DiffSpec): string[] {
  const paths = new Set<string>();
  if (spec.oldRelPath) paths.add(spec.oldRelPath);
  if (spec.relPath) paths.add(spec.relPath);
  return Array.from(paths);
}

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

export function parseBranchLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function readFetchHeadMtime(gitDir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(gitDir, "FETCH_HEAD"));
    return Math.trunc(stat.mtimeMs);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

export function gitSyncErrorFromGitError(error: GitError): GitSyncError {
  return {
    kind: error.kind,
    message: error.message,
    ...(error.stderr ? { details: error.stderr } : {}),
  };
}

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

function entryIsSelected(entry: GitStatusEntry, selected: Set<string>): boolean {
  return selected.has(entry.relPath) || (entry.oldRelPath ? selected.has(entry.oldRelPath) : false);
}

export function noop(): void {}

export function assertHasHead(branch: BranchInfo | null): void {
  if (branch && !branch.isUnborn) return;
  throw new GitError("no-head", "Repository has no commits yet — make an initial commit first.", {
    hint: { kind: "make-initial-commit" } satisfies GitActionHint,
  });
}

export type CheckoutResolution =
  | { kind: "local"; ref: string }
  | { kind: "track"; remoteRef: string };

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

function stripRemotePrefix(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
}
