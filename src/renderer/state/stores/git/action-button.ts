/**
 * Pure Source Control action-button selector.
 *
 * The ordering mirrors the task-plan state machine: first match wins, so more
 * specific commit/dirty states are evaluated before clean remote-sync states.
 */
import i18next from "i18next";
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

/** Looks up a translation key; the panel passes its `t` so labels follow language changes. */
export type GitActionButtonTranslate = (key: string) => string;

/** Selects the primary Source Control action using the 11-state plan order. */
export function selectGitActionButton(
  input: GitActionButtonInput,
  translate: GitActionButtonTranslate = (key) => i18next.t(key),
): GitActionButtonState {
  const label = (key: string): string => translate(`files:git.actionButton.${key}`);
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
    return action("initialize-repository", label("initializeRepository"), { menuMode: "none" });
  }

  if (branch?.isUnborn && staged > 0 && hasDraft) {
    return action("make-initial-commit", label("makeInitialCommit"));
  }

  if (branch?.isUnborn && (staged === 0 || !hasDraft)) {
    return action("commit-disabled", label("commit"), {
      disabled: true,
      hint: commitReadinessHint(label, hasDraft, staged > 0),
    });
  }

  if (staged > 0 && hasDraft) {
    return action("commit", label("commit"));
  }

  if (staged > 0 && !hasDraft) {
    return action("commit-disabled", label("commit"), {
      disabled: true,
      hint: commitReadinessHint(label, hasDraft, true),
    });
  }

  if (staged === 0 && unstaged > 0) {
    return action("stage-all", label("stageAll"));
  }

  if (dirty === 0 && ahead > 0 && behind > 0) {
    return action("sync", label("sync"), { menuMode: "sync" });
  }

  if (dirty === 0 && ahead > 0 && hasUpstream) {
    return action("push", label("push"), { menuMode: "sync" });
  }

  if (dirty === 0 && behind > 0 && ahead === 0) {
    return action("pull", label("pull"), { menuMode: "sync" });
  }

  if (dirty === 0 && !hasUpstream && hasRemote && input.capabilities.hasHEAD) {
    return action("publish-branch", label("publishBranch"), { menuMode: "sync" });
  }

  if (dirty === 0 && !hasRemote) {
    return action("no-remote", label("noRemote"), {
      disabled: true,
      staticLabel: true,
      menuMode: "sync",
    });
  }

  return action("up-to-date", label("upToDate"), {
    disabled: true,
    staticLabel: true,
    menuMode: "sync",
  });
}

/** Builds a disabled-commit hint without making callers duplicate copy. */
function commitReadinessHint(
  label: (key: string) => string,
  hasDraft: boolean,
  hasStagedChanges: boolean,
): string {
  if (!hasDraft && !hasStagedChanges) return label("hintStageAndMessage");
  if (!hasDraft) return label("hintMessage");
  return label("hintStage");
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
