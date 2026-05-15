import type { GitExpandedGroupKey, GitStatus, GitStatusEntry } from "../../../../../shared/types/git";

export interface GitGroupDescriptor {
  key: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
}

export const GIT_GROUP_ORDER: readonly Omit<GitGroupDescriptor, "entries">[] = [
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
  return GIT_GROUP_ORDER.map((group) => ({ ...group, entries: status[group.key] })).filter(
    (group) => group.entries.length > 0,
  );
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
