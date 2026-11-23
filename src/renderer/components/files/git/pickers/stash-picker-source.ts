import i18next from "i18next";
import type { StashEntry } from "../../../../../shared/git/types";
import { relativeTime } from "../../../../utils/time-format";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";

export type StashPickerMode = "apply" | "drop";

export interface StashPickItem extends PaletteItem {
  stash: StashEntry;
}

export interface CreateStashPickerSourceInput {
  workspaceId: string;
  mode?: StashPickerMode;
  listStashes: (workspaceId: string, signal?: AbortSignal) => Promise<StashEntry[] | undefined>;
  applyStash: (workspaceId: string, index: number) => Promise<boolean>;
  requestDrop?: (item: StashPickItem) => void;
}

export function createStashPickerSource(
  input: CreateStashPickerSourceInput,
): PaletteSource<StashPickItem> {
  const t = i18next.t.bind(i18next);
  const mode: StashPickerMode = input.mode ?? "apply";

  return {
    id: "git.stash-picker",
    title:
      mode === "drop"
        ? t("files:git.stashPicker.dropTitle")
        : t("files:git.stashPicker.applyTitle"),
    placeholder:
      mode === "drop"
        ? t("files:git.stashPicker.dropPlaceholder")
        : t("files:git.stashPicker.applyPlaceholder"),
    emptyQueryMessage: t("files:git.stashPicker.loading"),
    noResultsMessage: t("files:git.stashPicker.noResults"),
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly StashPickItem[]> {
      const stashes = await input.listStashes(input.workspaceId, signal);
      if (signal.aborted || !stashes) return [];

      const lowerQuery = query.trim().toLowerCase();
      return stashes.map(stashToItem).filter((item) => matchesStashQuery(item, lowerQuery));
    },

    accept(item): void {
      if (mode === "drop") {
        input.requestDrop?.(item);
        return;
      }
      void input.applyStash(input.workspaceId, item.stash.index);
    },
  };
}

function stashToItem(stash: StashEntry): StashPickItem {
  const t = i18next.t.bind(i18next);
  const subject = stash.message.trim() || t("files:git.stashPicker.noMessage");
  const refLabel = `stash@{${stash.index}}`;
  return {
    id: `stash:${stash.index}:${stash.sha}`,
    label: `${refLabel} ${subject}`,
    description: relativeTime(stash.createdAt),
    kindLabel: stash.branch ?? undefined,
    ariaLabel: `${refLabel} ${subject}`,
    stash,
  };
}

function matchesStashQuery(item: StashPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.label, item.stash.message, item.stash.branch ?? "", item.stash.sha].some((value) =>
    value.toLowerCase().includes(lowerQuery),
  );
}
