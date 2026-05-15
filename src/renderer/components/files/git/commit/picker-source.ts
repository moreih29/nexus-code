/**
 * Commit picker source for single-commit cherry-pick.
 *
 * Commits are immutable identities, so this source is separate from branch
 * and ref pickers. It starts on the current branch and exposes one explicit
 * "Pick from another branch…" row that lets the panel retarget the commit
 * list without enabling multi-pick or checkout side effects.
 */
import type { LogEntry } from "../../../../../shared/types/git";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";

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
  const ref = input.ref?.trim() || undefined;
  const branchLabel = ref ?? input.currentBranch?.trim() ?? "current branch";
  return {
    id: "git.commit-picker",
    title: `Pick from ${branchLabel}`,
    placeholder: "Search commits to cherry-pick…",
    emptyQueryMessage: "Loading commits…",
    noResultsMessage: "No matching commits.",
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly CommitPickItem[]> {
      const commits = await input.listRecentCommits(input.workspaceId, signal, ref);
      if (signal.aborted || !commits) return [];
      const lowerQuery = query.trim().toLowerCase();
      const branchFlowItem: CommitPickItem = {
        id: "commit-picker:pick-from-branch",
        label: "Pick from another branch…",
        description: "Choose a branch, then pick one commit",
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

/** Formats a compact relative timestamp for commit rows. */
function relativeTime(isoDate: string): string {
  const then = Date.parse(isoDate);
  if (!Number.isFinite(then)) return "unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
