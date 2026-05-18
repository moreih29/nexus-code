/**
 * RefPickerSource — shared picker source for "create branch from ref" style
 * flows. It intentionally combines moving labels (branches/tags) with recent
 * immutable commits while returning only the selected ref string to callers.
 */
import type { BranchList, LogEntry, Tag } from "../../../../../shared/git/types";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";
import { relativeTime } from "../utils/relative-time";

export type RefPickKind = "branch" | "remote" | "tag" | "commit";

export interface RefPickItem extends PaletteItem {
  kind: RefPickKind;
  ref: string;
  sha?: string;
}

export interface CreateRefPickerSourceInput {
  workspaceId: string;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  listRecentCommits: (workspaceId: string, signal?: AbortSignal) => Promise<LogEntry[] | undefined>;
  acceptRef: (ref: string, item: RefPickItem) => void;
}

/**
 * Builds the git.ref-picker source used by create-from-ref and later ref-pivot
 * flows. Empty query eagerly loads a bounded branch/tag/recent-commit set.
 */
export function createRefPickerSource(
  input: CreateRefPickerSourceInput,
): PaletteSource<RefPickItem> {
  return {
    id: "git.ref-picker",
    title: "Select ref",
    placeholder: "Search branches, tags, and recent commits…",
    emptyQueryMessage: "Loading refs…",
    noResultsMessage: "No matching refs.",
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly RefPickItem[]> {
      const [branches, tags, commits] = await Promise.all([
        input.listBranches(input.workspaceId, signal),
        input.listTags(input.workspaceId, signal),
        input.listRecentCommits(input.workspaceId, signal),
      ]);
      if (signal.aborted) return [];

      const lowerQuery = query.trim().toLowerCase();
      return [
        ...branchItems(branches),
        ...tagItems(tags ?? []),
        ...commitItems(commits ?? []),
      ].filter((item) => matchesRefQuery(item, lowerQuery));
    },

    accept(item): void {
      input.acceptRef(item.ref, item);
    },
  };
}

/**
 * Converts local and remote branches into ref picker items.
 */
function branchItems(branches: BranchList | undefined): RefPickItem[] {
  if (!branches) return [];
  const current = branches.current?.current ?? null;
  const locals = [...branches.local].sort((a, b) => a.localeCompare(b));
  const remotes = [...branches.remote]
    .filter((name) => !name.endsWith("/HEAD"))
    .sort((a, b) => a.localeCompare(b));

  return [
    ...locals.map((name) => ({
      id: `branch:${name}`,
      label: name,
      description: name === current ? "Current branch" : "Local branch",
      kindLabel: name === current ? "current" : "branch",
      kind: "branch" as const,
      ref: name,
    })),
    ...remotes.map((name) => ({
      id: `remote:${name}`,
      label: name,
      description: "Remote branch",
      kindLabel: "remote",
      kind: "remote" as const,
      ref: name,
    })),
  ];
}

/**
 * Converts tag metadata into ref picker items.
 */
function tagItems(tags: readonly Tag[]): RefPickItem[] {
  return [...tags]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tag) => ({
      id: `tag:${tag.name}`,
      label: tag.name,
      description: tag.message ?? "Tag",
      kindLabel: "tag",
      kind: "tag" as const,
      ref: tag.name,
      sha: tag.sha,
    }));
}

/**
 * Converts recent commits into ref picker items.
 */
function commitItems(commits: readonly LogEntry[]): RefPickItem[] {
  return commits.map((commit) => ({
    id: `commit:${commit.sha}`,
    label: commit.subject || commit.shortSha || commit.sha.slice(0, 7),
    description: `${commit.authorName} · ${relativeTime(commit.authoredAt)}`,
    kindLabel: commit.shortSha ?? commit.sha.slice(0, 7),
    kind: "commit" as const,
    ref: commit.sha,
    sha: commit.sha,
  }));
}

/**
 * Case-insensitive query matcher spanning labels, details, refs, and SHAs.
 */
function matchesRefQuery(item: RefPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.label, item.description, item.detail, item.kindLabel, item.ref, item.sha]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(lowerQuery));
}

