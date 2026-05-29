/**
 * Commit picker source for single-commit cherry-pick.
 *
 * Commits are immutable identities, so this source is separate from branch
 * and ref pickers. It starts on the current branch and exposes one explicit
 * "Pick from another branch…" row that lets the panel retarget the commit
 * list without enabling multi-pick or checkout side effects.
 */
import i18next from "i18next";
import type { LogEntry } from "../../../../../shared/git/types";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";
import { relativeTime } from "../utils/relative-time";

export type CommitPickAction = { kind: "commit"; sha: string } | { kind: "pick-from-branch" };

export interface CommitPickItem extends PaletteItem {
  action: CommitPickAction;
}

export interface CreateCommitPickerSourceInput {
  workspaceId: string;
  currentBranch?: string | null;
  ref?: string | null;
  listRecentCommits: (
    workspaceId: string,
    signal?: AbortSignal,
    ref?: string,
  ) => Promise<LogEntry[] | undefined>;
  acceptCommit: (sha: string, item: CommitPickItem) => void;
  requestBranch: () => void;
}

/** Builds the `git.commit-picker` PaletteSource. */
export function createCommitPickerSource(
  input: CreateCommitPickerSourceInput,
): PaletteSource<CommitPickItem> {
  const t = i18next.t.bind(i18next);
  const ref = input.ref?.trim() || undefined;
  return {
    id: "git.commit-picker",
    title: t("files:git.commitPicker.title"),
    placeholder: t("files:git.commitPicker.placeholder"),
    emptyQueryMessage: t("files:git.commitPicker.loading"),
    noResultsMessage: t("files:git.commitPicker.noResults"),
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly CommitPickItem[]> {
      const commits = await input.listRecentCommits(input.workspaceId, signal, ref);
      if (signal.aborted || !commits) return [];
      const lowerQuery = query.trim().toLowerCase();
      const branchFlowItem: CommitPickItem = {
        id: "commit-picker:pick-from-branch",
        label: t("files:git.commitPicker.pickFromBranch"),
        description: t("files:git.commitPicker.pickFromBranchPlaceholder"),
        kindLabel: "branch",
        action: { kind: "pick-from-branch" },
      };
      return [
        ...commitItems(commits).filter((item) => matchesCommitQuery(item, lowerQuery)),
        branchFlowItem,
      ];
    },

    accept(item): void {
      if (item.action.kind === "pick-from-branch") {
        input.requestBranch();
        return;
      }
      input.acceptCommit(item.action.sha, item);
    },
  };
}

/** Converts recent log entries into single-pick commit rows. */
function commitItems(commits: readonly LogEntry[]): CommitPickItem[] {
  return commits.map((commit) => {
    const shortSha = commit.shortSha ?? commit.sha.slice(0, 7);
    return {
      id: `commit-picker:${commit.sha}`,
      label: commit.subject || shortSha,
      description: `${commit.authorName} · ${relativeTime(commit.authoredAt)}`,
      kindLabel: shortSha,
      detail: commit.body,
      action: { kind: "commit" as const, sha: commit.sha },
    };
  });
}

/** Case-insensitive query matcher across commit display fields. */
function matchesCommitQuery(item: CommitPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  const sha = item.action.kind === "commit" ? item.action.sha : undefined;
  return [item.label, item.description, item.detail, item.kindLabel, sha]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(lowerQuery));
}

