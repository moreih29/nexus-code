/**
 * StashPickerSource — Quick-pick PaletteSource for stash stack operations.
 *
 * The picker opens with the full stash list (`searchOnEmptyQuery`).
 *
 *   - "apply" mode (default): Enter → apply selected stash.
 *   - "drop" mode:            Enter → request drop confirmation for selected stash.
 */
import i18next from "i18next";
import type { StashEntry } from "../../../../../shared/git/types";
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
  /** Called in drop mode when the user selects a stash; caller shows confirm dialog. */
  requestDrop?: (item: StashPickItem) => void;
}

/**
 * Builds the stash picker source consumed by CommandPalette.
 */
export function createStashPickerSource(
  input: CreateStashPickerSourceInput,
): PaletteSource<StashPickItem> {
  const t = i18next.t.bind(i18next);
  const mode: StashPickerMode = input.mode ?? "apply";

  return {
    id: "git.stash-picker",
    title: mode === "drop" ? t("files:git.stashPicker.dropTitle") : t("files:git.stashPicker.applyTitle"),
    placeholder: mode === "drop" ? t("files:git.stashPicker.dropPlaceholder") : t("files:git.stashPicker.applyPlaceholder"),
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

/**
 * Converts a stash entry into the palette row shape.
 */
function stashToItem(stash: StashEntry): StashPickItem {
  const t = i18next.t.bind(i18next);
  const subject = stash.message.trim() || t("files:git.stashPicker.noMessage");
  const refLabel = `stash@{${stash.index}}`;
  return {
    id: `stash:${stash.index}:${stash.sha}`,
    label: `${refLabel} ${subject}`,
    description: formatRelativeTime(stash.createdAt),
    kindLabel: stash.branch ?? undefined,
    ariaLabel: `${refLabel} ${subject}`,
    stash,
  };
}

/**
 * Case-insensitive match against label, stash subject, branch, and SHA.
 */
function matchesStashQuery(item: StashPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.label, item.stash.message, item.stash.branch ?? "", item.stash.sha].some((value) =>
    value.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Formats a compact client-side relative timestamp for stash descriptions.
 */
function formatRelativeTime(createdAt: number, now: number = Date.now()): string {
  const t = i18next.t.bind(i18next);
  const diffMs = Math.max(0, now - createdAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return t("files:git.stashPicker.justNow");
  if (diffMs < hour) return t("files:git.stashPicker.minutesAgo", { count: Math.floor(diffMs / minute) });
  if (diffMs < day) return t("files:git.stashPicker.hoursAgo", { count: Math.floor(diffMs / hour) });
  return t("files:git.stashPicker.daysAgo", { count: Math.floor(diffMs / day) });
}
