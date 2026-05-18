/**
 * Pure Source Control action-button selector.
 *
 * The ordering mirrors the task-plan state machine: first match wins, so more
 * specific commit/dirty states are evaluated before clean remote-sync states.
 */
import type { BranchInfo, RepoCapabilities, RepoInfo } from "../../../../shared/git/types";

export type GitActionButtonKind =
  | "initialize-repository"
  | "make-initial-commit"
  | "commit-disabled"
  | "commit"
  | "stage-all"
  | "sync"
  | "push"
  | "pull"
  | "publish-branch"
  | "no-remote"
  | "up-to-date";

export type GitActionMenuMode = "commit" | "sync" | "none";

export interface GitDirtyCounts {
  readonly staged: number;
  readonly working: number;
  readonly untracked: number;
  readonly merge?: number;
}

export interface GitActionButtonInput {
  readonly repoKind: RepoInfo["kind"];
  readonly capabilities: RepoCapabilities;
  readonly branch: BranchInfo | null;
  readonly dirty: GitDirtyCounts;
  readonly commitDraft: string;
}

export interface GitActionButtonState {
  readonly kind: GitActionButtonKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly staticLabel: boolean;
  readonly menuMode: GitActionMenuMode;
  readonly hint?: string;
}

/** Selects the primary Source Control action using the 11-state plan order. */
export function selectGitActionButton(input: GitActionButtonInput): GitActionButtonState {
  const hasDraft = input.commitDraft.trim().length > 0;
  const staged = input.dirty.staged;
  const unstaged = input.dirty.working + input.dirty.untracked + (input.dirty.merge ?? 0);
  const dirty = staged + unstaged;
  const branch = input.branch;
  const hasRemote = input.capabilities.remotes.length > 0;
  const hasUpstream = Boolean(branch?.upstream);
  const ahead = branch?.ahead ?? 0;
  const behind = branch?.behind ?? 0;

  if (input.repoKind === "non-repo") {
    return action("initialize-repository", "Initialize Repository", { menuMode: "none" });
  }

  if (branch?.isUnborn && staged > 0 && hasDraft) {
    return action("make-initial-commit", "Make Initial Commit");
  }

  if (branch?.isUnborn && (staged === 0 || !hasDraft)) {
    return action("commit-disabled", "Commit", {
      disabled: true,
      hint: commitReadinessHint(hasDraft, staged > 0),
    });
  }

  if (staged > 0 && hasDraft) {
    return action("commit", "Commit");
  }

  if (staged > 0 && !hasDraft) {
    return action("commit-disabled", "Commit", {
      disabled: true,
      hint: commitReadinessHint(hasDraft, true),
    });
  }

  if (staged === 0 && unstaged > 0) {
    return action("stage-all", "Stage All");
  }

  if (dirty === 0 && ahead > 0 && behind > 0) {
    return action("sync", "Sync", { menuMode: "sync" });
  }

  if (dirty === 0 && ahead > 0 && hasUpstream) {
    return action("push", "Push", { menuMode: "sync" });
  }

  if (dirty === 0 && behind > 0 && ahead === 0) {
    return action("pull", "Pull", { menuMode: "sync" });
  }

  if (dirty === 0 && !hasUpstream && hasRemote && input.capabilities.hasHEAD) {
    return action("publish-branch", "Publish Branch", { menuMode: "sync" });
  }

  if (dirty === 0 && !hasRemote) {
    return action("no-remote", "No remote configured", {
      disabled: true,
      staticLabel: true,
      menuMode: "sync",
    });
  }

  return action("up-to-date", "Up to date", {
    disabled: true,
    staticLabel: true,
    menuMode: "sync",
  });
}

/** Builds a disabled-commit hint without making callers duplicate copy. */
function commitReadinessHint(hasDraft: boolean, hasStagedChanges: boolean): string {
  if (!hasDraft && !hasStagedChanges) return "Stage changes and enter a commit message.";
  if (!hasDraft) return "Enter a commit message.";
  return "Stage changes before committing.";
}

/** Normalizes optional state fields for one selected action. */
function action(
  kind: GitActionButtonKind,
  label: string,
  options: Partial<Omit<GitActionButtonState, "kind" | "label">> = {},
): GitActionButtonState {
  return {
    kind,
    label,
    disabled: options.disabled ?? false,
    staticLabel: options.staticLabel ?? false,
    menuMode: options.menuMode ?? "commit",
    ...(options.hint ? { hint: options.hint } : {}),
  };
}
