/**
 * Rebase target picker source.
 *
 * Rebase targets are existing refs only. Keeping this source separate from
 * BranchPicker prevents checkout/create shortcuts from leaking into the
 * workflow picker and guarantees the current branch is not offered as the
 * branch to rebase onto.
 */
import i18next from "i18next";
import type { BranchList } from "../../../../../shared/git/types";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";

export type RebaseTargetPickKind = "local" | "remote";

export interface RebaseTargetPickItem extends PaletteItem {
  kind: RebaseTargetPickKind;
  ref: string;
}

export interface CreateRebaseTargetPickerSourceInput {
  workspaceId: string;
  currentBranch?: string | null;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  acceptTarget: (ref: string, item: RebaseTargetPickItem) => void;
}

/** Builds the `git.rebase-target-picker` PaletteSource. */
export function createRebaseTargetPickerSource(
  input: CreateRebaseTargetPickerSourceInput,
): PaletteSource<RebaseTargetPickItem> {
  const t = i18next.t.bind(i18next);
  const current = input.currentBranch?.trim() || null;
  return {
    id: "git.rebase-target-picker",
    title: current ? t("files:git.rebasePicker.titleWithBranch", { current }) : t("files:git.rebasePicker.title"),
    placeholder: t("files:git.rebasePicker.placeholder"),
    emptyQueryMessage: t("files:git.rebasePicker.loadingBranches"),
    noResultsMessage: t("files:git.rebasePicker.noMatchingBranches"),
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly RebaseTargetPickItem[]> {
      const branches = await input.listBranches(input.workspaceId, signal);
      if (signal.aborted || !branches) return [];
      const lowerQuery = query.trim().toLowerCase();
      return buildRebaseTargetItems(branches, current).filter((item) =>
        matchesTargetQuery(item, lowerQuery),
      );
    },

    accept(item): void {
      input.acceptTarget(item.ref, item);
    },
  };
}

/** Converts a branch list into selectable rebase targets. */
export function buildRebaseTargetItems(
  branches: BranchList,
  currentBranch: string | null = branches.current?.current ?? null,
): RebaseTargetPickItem[] {
  const t = i18next.t.bind(i18next);
  const current = currentBranch ?? branches.current?.current ?? null;
  const locals = [...branches.local]
    .filter((name) => name !== current)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `rebase-local:${name}`,
      label: name,
      description: t("files:git.rebasePicker.descriptionLocal"),
      kindLabel: "branch",
      kind: "local" as const,
      ref: name,
    }));

  const remotes = [...branches.remote]
    .filter((name) => !name.endsWith("/HEAD"))
    .filter((name) => name !== current)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `rebase-remote:${name}`,
      label: name,
      description: t("files:git.rebasePicker.descriptionRemote"),
      kindLabel: "remote",
      kind: "remote" as const,
      ref: name,
    }));

  return [...locals, ...remotes];
}

/** Case-insensitive query matcher for labels and full refs. */
function matchesTargetQuery(item: RebaseTargetPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.label, item.description, item.kindLabel, item.ref].some((value) =>
    value?.toLowerCase().includes(lowerQuery),
  );
}
