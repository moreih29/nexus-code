/**
 * StashPickerSource — Quick-pick PaletteSource for stash stack operations.
 *
 * The picker opens with the full stash list (`searchOnEmptyQuery`).
 *
 *   - "apply" mode (default): Enter → apply selected stash.
 *   - "drop" mode:            Enter → request drop confirmation for selected stash.
 */
import type { StashEntry } from "../../../../../shared/types/git";
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
  const mode: StashPickerMode = input.mode ?? "apply";

  return {
    id: "git.stash-picker",
    title: mode === "drop" ? "Drop Stash" : "Stashes",
    placeholder: mode === "drop" ? "Select a stash to drop…" : "Search stashes…",
    emptyQueryMessage: "Loading stashes…",
    noResultsMessage: "No matching stashes.",
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
  const subject = stash.message.trim() || "(no message)";
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
  const diffMs = Math.max(0, now - createdAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}
