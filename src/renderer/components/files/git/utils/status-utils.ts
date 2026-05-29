import i18next from "i18next";
import type {
  GitExpandedGroupKey,
  GitStatus,
  GitStatusEntry,
} from "../../../../../shared/git/types";

export interface GitGroupDescriptor {
  key: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
}

type GitGroupOrderItem = Omit<GitGroupDescriptor, "entries">;

const GIT_GROUP_KEYS: readonly GitExpandedGroupKey[] = ["merge", "staged", "working", "untracked"];

function getGitGroupLabel(key: GitExpandedGroupKey): string {
  const t = i18next.t.bind(i18next);
  switch (key) {
    case "merge": return t("files:git.statusGroups.merge");
    case "staged": return t("files:git.statusGroups.staged");
    case "working": return t("files:git.statusGroups.working");
    case "untracked": return t("files:git.statusGroups.untracked");
  }
}

/** @deprecated Use buildGitGroups instead. Kept for backward compat with tests. */
export const GIT_GROUP_ORDER: readonly GitGroupOrderItem[] = [
  { key: "merge", label: "Merge Changes" },
  { key: "staged", label: "Staged Changes" },
  { key: "working", label: "Changes" },
  { key: "untracked", label: "Untracked" },
];

/**
 * Build the visible Source Control groups in fixed VSCode-style order.
 */
export function buildGitGroups(status: GitStatus | null | undefined): GitGroupDescriptor[] {
  if (!status) return [];
  return GIT_GROUP_KEYS
    .map((key) => ({ key, label: getGitGroupLabel(key), entries: status[key] }))
    .filter((group) => group.entries.length > 0);
}

/**
 * Derive the single-letter badge shown for an entry in a specific group.
 */
export function getGitStatusCode(groupKey: GitExpandedGroupKey, entry: GitStatusEntry): string {
  if (groupKey === "merge") return "!";
  if (groupKey === "untracked") return "?";
  const code = groupKey === "staged" ? entry.xy[0] : entry.xy[1];
  return code && code !== "." ? code : "M";
}

/**
 * Return the unique relPaths used by store operations for a set of rows.
 */
export function collectGitEntryPaths(entries: readonly GitStatusEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.relPath)));
}

/**
 * Human-readable row label, including the old path when Git reports a rename.
 */
export function formatGitEntryPath(entry: GitStatusEntry): string {
  return entry.oldRelPath ? `${entry.oldRelPath} → ${entry.relPath}` : entry.relPath;
}
