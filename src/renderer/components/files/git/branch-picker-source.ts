/**
 * BranchPickerSource — Quick-pick PaletteSource for VS Code-style "Checkout
 * to..." (`git.checkout`). The picker classifies the user's intent into one
 * of three discriminated actions and routes each to its own store call:
 *
 *   - `checkout`         → `git checkout <local>` (existing local branch).
 *   - `checkout-tracking`→ `git checkout --track <remote>/<short>` (remote-only;
 *                          deterministic across git versions and configs, so
 *                          we never depend on `branch.autoSetupMerge` or the
 *                          single-remote auto-track shortcut).
 *   - `create-branch`    → `git checkout -b <name>` (typed name with no exact
 *                          match against either local or remote-short).
 *
 * Item layout (mirrors VS Code "Git: Checkout to..."):
 *   1) Local branches — current first (kindLabel "current"), then alphabetical.
 *   2) Remote branches — short-name labels, hidden when a local branch with
 *      the same short name already exists.
 *   3) `+ Create new branch: '<query>'` — only when the query is non-empty
 *      and does not exactly match an existing local or remote-short name.
 *
 * `searchOnEmptyQuery: true` opts out of the workspace-symbol "type-to-search"
 * default — `search("")` fires immediately on open, so the full branch list
 * appears without typing.
 */

import type { BranchList } from "../../../../shared/types/git";
import type { PaletteAcceptContext, PaletteItem, PaletteSource } from "../../ui/palette/types";

export type BranchPickAction =
  | { kind: "checkout"; ref: string }
  | { kind: "checkout-tracking"; remoteRef: string }
  | { kind: "create-branch"; name: string };

export interface BranchPickItem extends PaletteItem {
  action: BranchPickAction;
}

export interface CreateBranchPickerSourceInput {
  workspaceId: string;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  checkout: (workspaceId: string, ref: string) => Promise<void>;
  checkoutTracking: (workspaceId: string, remoteRef: string) => Promise<void>;
  createBranch: (workspaceId: string, name: string, checkout?: boolean) => Promise<void>;
  title?: string;
  placeholder?: string;
  allowCreate?: boolean;
  acceptRef?: (ref: string, item: BranchPickItem) => void;
  requestDelete?: (item: BranchPickItem) => void;
  requestRename?: (item: BranchPickItem) => void;
  requestSetUpstream?: (item: BranchPickItem) => void;
}

export function createBranchPickerSource(
  input: CreateBranchPickerSourceInput,
): PaletteSource<BranchPickItem> {
  return {
    id: "git.branch-picker",
    title: input.title ?? "Checkout to",
    placeholder: input.placeholder ?? "Select a branch or type a name to create…",
    emptyQueryMessage: "Loading branches…",
    noResultsMessage: "No matching branches.",
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly BranchPickItem[]> {
      const list = await input.listBranches(input.workspaceId, signal);
      if (signal.aborted || !list) return [];

      const trimmed = query.trim();
      const lowerQuery = trimmed.toLowerCase();
      const currentName = list.current?.current ?? null;
      const isUnborn = list.current?.isUnborn === true;
      const localSet = new Set(list.local);

      // Local branches — current first, then alphabetical, all filtered.
      const otherLocals = list.local
        .filter((name) => name !== currentName)
        .filter((name) => matchesQuery(name, lowerQuery))
        .sort((a, b) => a.localeCompare(b));

      const localItems: BranchPickItem[] = [];
      // Skip the synthetic "current" row when HEAD is unborn. The branch
      // name comes from `git status -b` (which knows about unborn HEAD)
      // but `git branch --list` does not yet include it as a real ref, so
      // a checkout action on this entry would fail with `no-such-ref`.
      // The Source Control panel surfaces the unborn state via its own
      // banner; the picker just shows the create rows.
      if (currentName && !isUnborn && matchesQuery(currentName, lowerQuery)) {
        localItems.push({
          id: `local:${currentName}`,
          label: currentName,
          kindLabel: "current",
          description: "Local",
          action: { kind: "checkout", ref: currentName },
        });
      }
      for (const name of otherLocals) {
        localItems.push({
          id: `local:${name}`,
          label: name,
          description: "Local",
          action: { kind: "checkout", ref: name },
        });
      }

      // Remote branches — display by short name and dedupe against locals so
      // the user never sees both `main` (local) and `main` (remote). The
      // `checkout-tracking` action carries the full `<remote>/<short>` ref so
      // the main process can run an explicit `git checkout --track` instead
      // of relying on the auto-setup shortcut.
      const remoteShortMatches = new Set<string>();
      const remoteItems: BranchPickItem[] = [];
      for (const fullName of [...list.remote].sort((a, b) => a.localeCompare(b))) {
        const shortName = stripRemotePrefix(fullName);
        if (shortName.length === 0) continue;
        if (localSet.has(shortName)) continue;
        if (!matchesQuery(shortName, lowerQuery) && !matchesQuery(fullName, lowerQuery)) {
          continue;
        }
        if (remoteShortMatches.has(shortName)) continue; // first remote wins
        remoteShortMatches.add(shortName);
        remoteItems.push({
          id: `remote:${fullName}`,
          label: shortName,
          description: `Remote ${fullName}`,
          action: { kind: "checkout-tracking", remoteRef: fullName },
        });
      }

      const items: BranchPickItem[] = [...localItems, ...remoteItems];
      const exactLocalMatch = localSet.has(trimmed);
      const exactRemoteShortMatch = remoteShortMatches.has(trimmed);
      if (
        input.allowCreate !== false &&
        trimmed.length > 0 &&
        !exactLocalMatch &&
        !exactRemoteShortMatch
      ) {
        // On an unborn HEAD (`git init` with no commits), `git checkout -b X`
        // does not "create alongside" — it re-points the unborn HEAD's
        // symbolic ref so the previous branch name vanishes from
        // `git branch --list`. Spell that out in the picker label so the
        // user knows what's about to happen before they click.
        const unbornCurrent = list.current?.isUnborn && currentName ? currentName : null;
        const label = unbornCurrent
          ? `Rename unborn '${unbornCurrent}' → '${trimmed}'`
          : `Create new branch: '${trimmed}'`;
        const ariaLabel = unbornCurrent
          ? `Rename unborn ${unbornCurrent} to ${trimmed}`
          : `Create new branch ${trimmed}`;
        items.push({
          id: `create:${trimmed}`,
          label,
          kindLabel: "+",
          ariaLabel,
          action: { kind: "create-branch", name: trimmed },
        });
      }
      return items;
    },

    accept(item: BranchPickItem, ctx?: PaletteAcceptContext): void {
      if (input.acceptRef) {
        input.acceptRef(refFromBranchPickItem(item), item);
        return;
      }

      const modifiers = ctx?.modifiers;
      const metaOrCtrl = modifiers?.meta === true || modifiers?.ctrl === true;

      if (metaOrCtrl && isDeleteKey(ctx?.key)) {
        input.requestDelete?.(item);
        return;
      }
      if (metaOrCtrl && isKey(ctx?.key, "r")) {
        input.requestRename?.(item);
        return;
      }
      if (metaOrCtrl && isKey(ctx?.key, "u")) {
        input.requestSetUpstream?.(item);
        return;
      }

      switch (item.action.kind) {
        case "checkout":
          void input.checkout(input.workspaceId, item.action.ref);
          return;
        case "checkout-tracking":
          void input.checkoutTracking(input.workspaceId, item.action.remoteRef);
          return;
        case "create-branch":
          void input.createBranch(input.workspaceId, item.action.name, true);
          return;
      }
    },
  };
}

/**
 * Extracts the ref string represented by a branch picker item without running
 * checkout. HistoryRefSwitcher uses this so viewing another ref never mutates
 * the working tree.
 */
function refFromBranchPickItem(item: BranchPickItem): string {
  switch (item.action.kind) {
    case "checkout":
      return item.action.ref;
    case "checkout-tracking":
      return item.action.remoteRef;
    case "create-branch":
      return item.action.name;
  }
}

/**
 * Checks whether an accept came from the destructive branch shortcut.
 */
function isDeleteKey(key: string | undefined): boolean {
  return key === "Backspace" || key === "Delete";
}

/**
 * Case-insensitive shortcut key matcher.
 */
function isKey(key: string | undefined, expected: string): boolean {
  return key?.toLowerCase() === expected;
}

/**
 * Case-insensitive substring filter; empty query matches everything.
 */
function matchesQuery(value: string, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return value.toLowerCase().includes(lowerQuery);
}

/**
 * Strips the `<remote>/` prefix from a `git branch --remotes` short ref. When
 * no slash is present the input is returned unchanged so non-conforming
 * remote names degrade gracefully.
 */
function stripRemotePrefix(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
}
