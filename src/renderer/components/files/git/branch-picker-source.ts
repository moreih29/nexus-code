/**
 * BranchPickerSource — Quick-pick PaletteSource for VS Code-style branch
 * switching. The picker fronts both checkout (existing branch) and
 * create-branch (new name) in a single keyboard-friendly surface.
 *
 * Item layout (matching VS Code "Git: Checkout to..."):
 *   1) `+ Create new branch: '<query>'` — only when query is non-empty
 *      and does not exactly match an existing local branch.
 *   2) Local branches (current branch first, marked with kindLabel).
 *   3) Remote branches (origin/HEAD entries are filtered upstream).
 */

import type { BranchList } from "../../../../shared/types/git";
import type {
  PaletteAcceptContext,
  PaletteItem,
  PaletteSource,
} from "../../ui/palette/types";

export interface BranchPickItem extends PaletteItem {
  action:
    | { kind: "checkout"; ref: string }
    | { kind: "create-branch"; name: string };
}

export interface CreateBranchPickerSourceInput {
  workspaceId: string;
  listBranches: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<BranchList | undefined>;
  checkout: (workspaceId: string, ref: string) => Promise<void>;
  createBranch: (
    workspaceId: string,
    name: string,
    checkout?: boolean,
  ) => Promise<void>;
}

export function createBranchPickerSource(
  input: CreateBranchPickerSourceInput,
): PaletteSource<BranchPickItem> {
  return {
    id: "git.branch-picker",
    title: "Switch Branch",
    placeholder: "Type a branch name to filter or create…",
    emptyQueryMessage: "Type a branch name to filter or create.",
    noResultsMessage: "No matching branches.",

    async search(query, signal): Promise<readonly BranchPickItem[]> {
      const list = await input.listBranches(input.workspaceId, signal);
      if (signal.aborted || !list) return [];

      const trimmed = query.trim();
      const lowerQuery = trimmed.toLowerCase();
      const currentName = list.current?.current ?? null;

      // Local branches — current first, then alphabetical, all filtered.
      const local = list.local
        .filter((name) => name !== currentName)
        .filter((name) => matchesQuery(name, lowerQuery))
        .sort((a, b) => a.localeCompare(b));

      const localItems: BranchPickItem[] = [];
      if (currentName && matchesQuery(currentName, lowerQuery)) {
        localItems.push({
          id: `local:${currentName}`,
          label: currentName,
          kindLabel: "current",
          description: "Local",
          action: { kind: "checkout", ref: currentName },
        });
      }
      for (const name of local) {
        localItems.push({
          id: `local:${name}`,
          label: name,
          description: "Local",
          action: { kind: "checkout", ref: name },
        });
      }

      const remoteItems: BranchPickItem[] = list.remote
        .filter((name) => matchesQuery(name, lowerQuery))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({
          id: `remote:${name}`,
          label: name,
          description: "Remote",
          action: { kind: "checkout", ref: name },
        }));

      // Create-new entry: shown only when query is non-empty and no exact
      // local match. Placed at top to match VS Code's quick-pick layout.
      const items: BranchPickItem[] = [];
      const exactLocalMatch = list.local.some((name) => name === trimmed);
      if (trimmed.length > 0 && !exactLocalMatch) {
        items.push({
          id: `create:${trimmed}`,
          label: `Create new branch: '${trimmed}'`,
          kindLabel: "+",
          ariaLabel: `Create new branch ${trimmed}`,
          action: { kind: "create-branch", name: trimmed },
        });
      }
      items.push(...localItems, ...remoteItems);
      return items;
    },

    accept(item: BranchPickItem, _ctx: PaletteAcceptContext): void {
      if (item.action.kind === "checkout") {
        void input.checkout(input.workspaceId, item.action.ref);
      } else {
        void input.createBranch(input.workspaceId, item.action.name, true);
      }
    },
  };
}

/**
 * Case-insensitive substring filter; empty query matches everything.
 */
function matchesQuery(value: string, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return value.toLowerCase().includes(lowerQuery);
}
