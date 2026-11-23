import i18next from "i18next";
import type { BranchList } from "../../../../../shared/git/types";
import type { PaletteAcceptContext, PaletteItem, PaletteSource } from "../../../ui/palette/types";

export type BranchPickAction =
  | { kind: "checkout"; ref: string }
  | { kind: "checkout-tracking"; remoteRef: string }
  | { kind: "create-branch"; name: string };

export interface BranchPickItem extends PaletteItem {
  action: BranchPickAction;
  current?: true;
}

export type BranchPickerSourceMode =
  | "switch"
  | "checkout"
  | "select-ref"
  | "rename"
  | "delete-local"
  | "delete-remote";

type NormalizedBranchPickerSourceMode = Exclude<BranchPickerSourceMode, "checkout">;

export interface CreateBranchPickerSourceInput {
  workspaceId: string;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  checkout: (workspaceId: string, ref: string) => Promise<void>;
  checkoutTracking: (workspaceId: string, remoteRef: string) => Promise<void>;
  createBranch: (workspaceId: string, name: string, checkout?: boolean) => Promise<void>;
  mode?: BranchPickerSourceMode;
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
  const mode = normalizeBranchPickerMode(input.mode);

  return {
    id: "git.branch-picker",
    title: input.title ?? defaultTitleForMode(mode),
    placeholder: input.placeholder ?? defaultPlaceholderForMode(mode),
    emptyQueryMessage: i18next.t("files:git.branch.picker.loadingBranches"),
    noResultsMessage: i18next.t("files:git.branch.picker.noMatchingBranches"),
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly BranchPickItem[]> {
      const list = await input.listBranches(input.workspaceId, signal);
      if (signal.aborted || !list) return [];

      const trimmed = query.trim();
      const lowerQuery = trimmed.toLowerCase();
      const currentName = list.current?.current ?? null;
      const isUnborn = list.current?.isUnborn === true;
      const localSet = new Set(list.local);
      const includeLocals = mode !== "delete-remote";
      const includeRemotes = mode === "switch" || mode === "select-ref" || mode === "delete-remote";

      const otherLocals = list.local
        .filter((name) => name !== currentName)
        .filter((name) => matchesQuery(name, lowerQuery))
        .sort((a, b) => a.localeCompare(b));

      const localItems: BranchPickItem[] = [];
      if (
        includeLocals &&
        mode !== "delete-local" &&
        currentName &&
        !isUnborn &&
        matchesQuery(currentName, lowerQuery)
      ) {
        localItems.push({
          id: `local:${currentName}`,
          label: currentName,
          kindLabel: i18next.t("files:git.pickerKind.current"),
          current: true,
          description: i18next.t("files:git.branch.picker.descriptionLocal"),
          action: { kind: "checkout", ref: currentName },
        });
      }
      if (includeLocals) {
        for (const name of otherLocals) {
          localItems.push({
            id: `local:${name}`,
            label: name,
            description: i18next.t("files:git.branch.picker.descriptionLocal"),
            action: { kind: "checkout", ref: name },
          });
        }
      }

      const remoteShortMatches = new Set<string>();
      const remoteItems: BranchPickItem[] = [];
      if (includeRemotes) {
        const dedupeRemoteShortNames = mode !== "delete-remote";
        for (const fullName of [...list.remote].sort((a, b) => a.localeCompare(b))) {
          const shortName = stripRemotePrefix(fullName);
          if (shortName.length === 0) continue;
          if (dedupeRemoteShortNames && localSet.has(shortName)) continue;
          if (!matchesQuery(shortName, lowerQuery) && !matchesQuery(fullName, lowerQuery)) {
            continue;
          }
          if (dedupeRemoteShortNames && remoteShortMatches.has(shortName)) continue;
          remoteShortMatches.add(shortName);
          remoteItems.push({
            id: `remote:${fullName}`,
            label: shortName,
            description: i18next.t("files:git.branch.picker.descriptionRemote", { ref: fullName }),
            action: { kind: "checkout-tracking", remoteRef: fullName },
          });
        }
      }

      const items: BranchPickItem[] = [...localItems, ...remoteItems];
      const exactLocalMatch = localSet.has(trimmed);
      const exactRemoteShortMatch = remoteShortMatches.has(trimmed);
      if (
        mode === "switch" &&
        input.allowCreate !== false &&
        trimmed.length > 0 &&
        !exactLocalMatch &&
        !exactRemoteShortMatch
      ) {
        const unbornCurrent = list.current?.isUnborn && currentName ? currentName : null;
        const label = unbornCurrent
          ? i18next.t("files:git.branch.picker.renameUnborn", {
              current: unbornCurrent,
              name: trimmed,
            })
          : i18next.t("files:git.branch.picker.createNew", { name: trimmed });
        const ariaLabel = label;
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

    accept(item: BranchPickItem, _ctx?: PaletteAcceptContext): void {
      if (mode === "select-ref" || input.acceptRef) {
        input.acceptRef?.(refFromBranchPickItem(item), item);
        return;
      }

      if (mode === "rename") {
        input.requestRename?.(item);
        return;
      }
      if (mode === "delete-local" || mode === "delete-remote") {
        input.requestDelete?.(item);
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

export function normalizeBranchPickerMode(
  mode: BranchPickerSourceMode | undefined,
): NormalizedBranchPickerSourceMode {
  if (!mode || mode === "checkout") return "switch";
  return mode;
}

function defaultTitleForMode(mode: NormalizedBranchPickerSourceMode): string {
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "switch":
      return t("files:git.branch.picker.checkoutTitle");
    case "select-ref":
      return t("files:git.branch.picker.selectRefTitle");
    case "rename":
      return t("files:git.branch.picker.renameTitle");
    case "delete-local":
      return t("files:git.branch.picker.deleteTitle");
    case "delete-remote":
      return t("files:git.branch.picker.deleteRemoteTitle");
  }
}

function defaultPlaceholderForMode(mode: NormalizedBranchPickerSourceMode): string {
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "switch":
      return t("files:git.branch.picker.checkoutPlaceholder");
    case "select-ref":
      return t("files:git.branch.picker.selectRefPlaceholder");
    case "rename":
      return t("files:git.branch.picker.renamePlaceholder");
    case "delete-local":
      return t("files:git.branch.picker.deletePlaceholder");
    case "delete-remote":
      return t("files:git.branch.picker.deleteRemotePlaceholder");
  }
}

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

function matchesQuery(value: string, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return value.toLowerCase().includes(lowerQuery);
}

function stripRemotePrefix(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
}
