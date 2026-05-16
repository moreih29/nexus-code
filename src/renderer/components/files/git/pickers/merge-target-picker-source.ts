/**
 * Merge target picker source.
 *
 * This deliberately stays separate from the checkout BranchPicker source:
 * merge targets are existing refs only, so the current branch and the
 * "Create new branch" row are both omitted before acceptance dispatches the
 * selected ref to the merge-options dialog.
 */
import type { BranchList } from "../../../../../shared/git/types";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";

export type MergeTargetPickKind = "local" | "remote";

export interface MergeTargetPickItem extends PaletteItem {
  kind: MergeTargetPickKind;
  ref: string;
}

export interface CreateMergeTargetPickerSourceInput {
  workspaceId: string;
  currentBranch?: string | null;
  title?: string;
  placeholder?: string;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  acceptTarget: (ref: string, item: MergeTargetPickItem) => void;
}

/** Builds the `git.merge-target-picker` PaletteSource. */
export function createMergeTargetPickerSource(
  input: CreateMergeTargetPickerSourceInput,
): PaletteSource<MergeTargetPickItem> {
  const current = input.currentBranch?.trim() || null;
  return {
    id: "git.merge-target-picker",
    title: input.title ?? (current ? `Merge branch into ${current}` : "Merge branch"),
    placeholder: input.placeholder ?? "Select a branch to merge…",
    emptyQueryMessage: "Loading branches…",
    noResultsMessage: "No matching branches.",
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly MergeTargetPickItem[]> {
      const branches = await input.listBranches(input.workspaceId, signal);
      if (signal.aborted || !branches) return [];
      const lowerQuery = query.trim().toLowerCase();
      return buildMergeTargetItems(branches, current).filter((item) =>
        matchesTargetQuery(item, lowerQuery),
      );
    },

    accept(item): void {
      input.acceptTarget(item.ref, item);
    },
  };
}

/** Converts a branch list into selectable merge targets. */
export function buildMergeTargetItems(
  branches: BranchList,
  currentBranch: string | null = branches.current?.current ?? null,
): MergeTargetPickItem[] {
  const current = currentBranch ?? branches.current?.current ?? null;
  const locals = [...branches.local]
    .filter((name) => name !== current)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `merge-local:${name}`,
      label: name,
      description: "Local branch",
      kindLabel: "branch",
      kind: "local" as const,
      ref: name,
    }));

  const remotes = [...branches.remote]
    .filter((name) => !name.endsWith("/HEAD"))
    .filter((name) => name !== current)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `merge-remote:${name}`,
      label: name,
      description: "Remote branch",
      kindLabel: "remote",
      kind: "remote" as const,
      ref: name,
    }));

  return [...locals, ...remotes];
}

/** Case-insensitive query matcher for labels and full refs. */
function matchesTargetQuery(item: MergeTargetPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.label, item.description, item.kindLabel, item.ref].some((value) =>
    value?.toLowerCase().includes(lowerQuery),
  );
}
