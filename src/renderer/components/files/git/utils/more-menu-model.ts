/**
 * Pure data models for the More menu — submenu shells, action discriminators,
 * and the small format/run helpers that drive them.
 *
 * Splitting these out of `GitMoreMenu.tsx` lets the renderer component focus
 * on portal placement, focus management, and event wiring while leaving the
 * "what does each menu entry look like, and when is it disabled?" logic in
 * one inspectable, test-only file. Every function here is side-effect free.
 */

import i18next from "i18next";
import type { BranchInfo, GitAutofetchIntervalMin } from "../../../../../shared/git/types";

export type GitRemotesMenuSpec =
  | { kind: "remote"; remote: string; label: string }
  | { kind: "empty"; label: string }
  | { kind: "action"; id: "add-remote" | "remove-remote"; label: string; disabled?: boolean };

export interface GitAutofetchMenuOption {
  readonly intervalMin: GitAutofetchIntervalMin;
  readonly label: string;
  readonly selected: boolean;
}

export type GitSubmenuSeparator = { kind: "separator"; id: string };

export type GitBranchMenuItemId =
  | "merge"
  | "rebase"
  | "create"
  | "create-from"
  | "rename"
  | "delete"
  | "delete-remote";

export type GitStashMenuItemId = "stash" | "stash-pop" | "open-stashes" | "drop-stash";

export type GitTagMenuItemId = "create" | "delete" | "delete-remote" | "push-tags";

export type GitTagPickerMenuMode = "create" | "delete-local" | "delete-remote";

/** Discriminator for the top-level submenu that may be open at any moment. */
export type GitMoreL1Submenu = "branch" | "remote" | "stash" | "tag" | "autofetch";

export interface GitBranchMenuActionHandlers {
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
}

export interface GitTagMenuActionHandlers {
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
}

export type GitPushTagsMenuAction =
  | { kind: "disabled"; reason: string }
  | { kind: "push"; remote: string }
  | { kind: "choose-remote"; remotes: readonly string[] };

export type GitDeleteRemoteTagMenuAction =
  | { kind: "disabled"; reason: string }
  | { kind: "open-picker"; remote: string }
  | { kind: "choose-remote"; remotes: readonly string[] };

export type GitSubmenuModelItem<TId extends string> =
  | {
      kind: "item";
      id: TId;
      label: string;
      disabled?: boolean;
      title?: string;
      placeholder?: boolean;
    }
  | GitSubmenuSeparator;

export type GitMoreMenuLayoutEntry =
  | { kind: "item"; label: string; destructive?: boolean }
  | { kind: "submenu"; label: string }
  | GitSubmenuSeparator;

/**
 * Builds the Remote submenu model used by the menu renderer and tests.
 */
export function buildGitRemotesMenuModel(remotes: readonly string[]): GitRemotesMenuSpec[] {
  const t = i18next.t.bind(i18next);
  const currentRemotes: GitRemotesMenuSpec[] =
    remotes.length > 0
      ? remotes.map((remote) => ({ kind: "remote", remote, label: remote }))
      : [{ kind: "empty", label: t("files:git.moreMenu.remote.noRemotes") }];
  return [
    ...currentRemotes,
    { kind: "action", id: "add-remote", label: t("files:git.moreMenu.remote.addRemote") },
    {
      kind: "action",
      id: "remove-remote",
      label: t("files:git.moreMenu.remote.removeRemote"),
      disabled: remotes.length === 0,
    },
  ];
}

/**
 * Returns the exact warning shown before removing the remote that backs the
 * current branch upstream, or null when removal does not affect tracking.
 */
export function buildRemoteUpstreamWarning(
  branch: BranchInfo | null | undefined,
  remote: string,
): string | null {
  if (!branch?.upstream?.startsWith(`${remote}/`)) return null;
  const t = i18next.t.bind(i18next);
  return t("files:git.removeRemote.upstreamWarning", { branch: branch.current, remote });
}

/** Builds the fixed Autofetch submenu options, marking the selected interval. */
export function buildAutofetchMenuModel(
  selected: GitAutofetchIntervalMin,
): GitAutofetchMenuOption[] {
  const t = i18next.t.bind(i18next);
  return [
    { intervalMin: 0, label: t("files:git.moreMenu.autofetch.off"), selected: selected === 0 },
    { intervalMin: 1, label: t("files:git.moreMenu.autofetch.every1min"), selected: selected === 1 },
    { intervalMin: 3, label: t("files:git.moreMenu.autofetch.every3min"), selected: selected === 3 },
  ];
}

/** Dispatches the selected Branch submenu entry to its owning panel handler. */
export function runGitBranchMenuAction(
  id: GitBranchMenuItemId,
  handlers: GitBranchMenuActionHandlers,
): void {
  switch (id) {
    case "merge":
      handlers.onMergeBranch();
      return;
    case "rebase":
      handlers.onRebaseBranch();
      return;
    case "create":
      handlers.onCreateBranch();
      return;
    case "create-from":
      handlers.onCreateBranchFrom();
      return;
    case "rename":
      handlers.onRenameBranch();
      return;
    case "delete":
      handlers.onDeleteBranch();
      return;
    case "delete-remote":
      handlers.onDeleteRemoteBranch();
      return;
  }
}

/** Dispatches Tag picker entries to their mode-specific picker state. */
export function runGitTagMenuAction(
  id: Exclude<GitTagMenuItemId, "push-tags">,
  handlers: GitTagMenuActionHandlers,
  remote?: string,
): void {
  switch (id) {
    case "create":
      handlers.onOpenTags("create");
      return;
    case "delete":
      handlers.onOpenTags("delete-local");
      return;
    case "delete-remote":
      handlers.onOpenTags("delete-remote", remote);
      return;
  }
}

/**
 * Builds the fixed top-level More menu shell. Tests assert this separately
 * from the click handlers so new git actions land in the decided groups.
 */
export function buildGitMoreMenuLayoutModel(canInit = false): GitMoreMenuLayoutEntry[] {
  const t = i18next.t.bind(i18next);
  return [
    { kind: "item", label: t("files:git.moreMenu.refresh") },
    ...(canInit ? [{ kind: "item" as const, label: t("files:git.moreMenu.initRepo") }] : []),
    { kind: "separator", id: "after-refresh" },
    { kind: "item", label: t("files:git.moreMenu.fetch") },
    { kind: "item", label: t("files:git.moreMenu.pull") },
    { kind: "item", label: t("files:git.moreMenu.push") },
    { kind: "separator", id: "after-sync" },
    { kind: "item", label: t("files:git.moreMenu.checkoutTo") },
    { kind: "submenu", label: t("files:git.moreMenu.branch.label") },
    { kind: "submenu", label: t("files:git.moreMenu.remote.label") },
    { kind: "submenu", label: t("files:git.moreMenu.stash.label") },
    { kind: "submenu", label: t("files:git.moreMenu.tag.label") },
    { kind: "separator", id: "after-refs" },
    { kind: "submenu", label: t("files:git.moreMenu.autofetch.label") },
    { kind: "separator", id: "after-autofetch" },
    { kind: "item", label: t("files:git.moreMenu.discardAllChanges"), destructive: true },
  ];
}

/**
 * Builds the Branch submenu shell with all branch workflows routed through
 * the panel-owned picker/dialog callbacks.
 */
export function buildGitBranchMenuModel({
  disabled = false,
  hasHead = false,
}: {
  disabled?: boolean;
  hasHead?: boolean;
}): GitSubmenuModelItem<GitBranchMenuItemId>[] {
  const t = i18next.t.bind(i18next);
  const workflowDisabled = disabled || !hasHead;
  const workflowReason = hasHead ? undefined : t("files:git.moreMenu.branch.requiresCommit");
  return [
    {
      kind: "item",
      id: "merge",
      label: t("files:git.moreMenu.branch.merge"),
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "rebase",
      label: t("files:git.moreMenu.branch.rebase"),
      disabled: workflowDisabled,
      title: workflowReason,
    },
    { kind: "separator", id: "after-workflow" },
    {
      kind: "item",
      id: "create",
      label: t("files:git.moreMenu.branch.create"),
      disabled,
    },
    {
      kind: "item",
      id: "create-from",
      label: t("files:git.moreMenu.branch.createFrom"),
      disabled,
    },
    { kind: "separator", id: "after-create" },
    {
      kind: "item",
      id: "rename",
      label: t("files:git.moreMenu.branch.rename"),
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "delete",
      label: t("files:git.moreMenu.branch.delete"),
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "delete-remote",
      label: t("files:git.moreMenu.branch.deleteRemote"),
      disabled: workflowDisabled,
      title: workflowReason,
    },
  ];
}

/** Builds the Stash submenu around the existing stash actions. */
export function buildGitStashMenuModel({
  disabled = false,
  hasHead = false,
  stashCount = 0,
}: {
  disabled?: boolean;
  hasHead?: boolean;
  stashCount?: number;
}): GitSubmenuModelItem<GitStashMenuItemId>[] {
  const t = i18next.t.bind(i18next);
  const stashReason = hasHead ? undefined : t("files:git.moreMenu.stash.requiresCommit");
  const stashPopReason =
    stashCount === 0
      ? t("files:git.moreMenu.stash.stashEmpty")
      : !hasHead
        ? t("files:git.moreMenu.stash.requiresCommit")
        : undefined;
  const dropStashReason =
    stashCount === 0
      ? t("files:git.moreMenu.stash.stashEmpty")
      : !hasHead
        ? t("files:git.moreMenu.stash.requiresCommit")
        : undefined;
  return [
    {
      kind: "item",
      id: "stash",
      label: t("files:git.moreMenu.stash.stash"),
      disabled: disabled || !hasHead,
      title: stashReason,
    },
    {
      kind: "item",
      id: "stash-pop",
      label: t("files:git.moreMenu.stash.stashPop"),
      disabled: disabled || stashCount === 0 || !hasHead,
      title: stashPopReason,
    },
    {
      kind: "item",
      id: "open-stashes",
      label: t("files:git.moreMenu.stash.stashes"),
      disabled: disabled || !hasHead,
      title: stashReason,
    },
    { kind: "separator", id: "before-drop-stash" },
    {
      kind: "item",
      id: "drop-stash",
      label: t("files:git.moreMenu.stash.dropStash"),
      disabled: disabled || stashCount === 0 || !hasHead,
      title: dropStashReason,
    },
  ];
}

/** Resolves Push Tags into disabled, immediate-push, or remote-picker flow. */
export function resolveGitPushTagsAction({
  disabled = false,
  hasHead = false,
  remotes,
}: {
  disabled?: boolean;
  hasHead?: boolean;
  remotes: readonly string[];
}): GitPushTagsMenuAction {
  const t = i18next.t.bind(i18next);
  if (remotes.length === 0) return { kind: "disabled", reason: t("files:git.moreMenu.tag.noRemotes") };
  if (disabled) return { kind: "disabled", reason: t("files:git.moreMenu.tag.repoBusy") };
  if (!hasHead) return { kind: "disabled", reason: t("files:git.moreMenu.tag.requiresCommit") };
  const [firstRemote] = remotes;
  if (remotes.length === 1 && firstRemote) return { kind: "push", remote: firstRemote };
  return { kind: "choose-remote", remotes };
}

/** Resolves Delete Remote Tag into disabled, direct, or remote-picker flow. */
export function resolveGitDeleteRemoteTagAction({
  disabled = false,
  hasHead = false,
  remotes,
}: {
  disabled?: boolean;
  hasHead?: boolean;
  remotes: readonly string[];
}): GitDeleteRemoteTagMenuAction {
  const t = i18next.t.bind(i18next);
  if (remotes.length === 0) return { kind: "disabled", reason: t("files:git.moreMenu.tag.noRemotes") };
  if (disabled) return { kind: "disabled", reason: t("files:git.moreMenu.tag.repoBusy") };
  if (!hasHead) return { kind: "disabled", reason: t("files:git.moreMenu.tag.requiresCommit") };
  const [firstRemote] = remotes;
  if (remotes.length === 1 && firstRemote) return { kind: "open-picker", remote: firstRemote };
  return { kind: "choose-remote", remotes };
}

/**
 * Builds the Tag submenu shell with mode-specific picker entries plus the
 * Push Tags bulk action.
 */
export function buildGitTagMenuModel({
  disabled = false,
  hasHead = false,
  remotes = [],
}: {
  disabled?: boolean;
  hasHead?: boolean;
  remotes?: readonly string[];
}): GitSubmenuModelItem<GitTagMenuItemId>[] {
  const t = i18next.t.bind(i18next);
  const tagDisabled = disabled || !hasHead;
  const tagReason = hasHead ? undefined : t("files:git.moreMenu.tag.requiresCommit");
  const deleteRemoteAction = resolveGitDeleteRemoteTagAction({ disabled, hasHead, remotes });
  const pushTagsAction = resolveGitPushTagsAction({ disabled, hasHead, remotes });
  return [
    {
      kind: "item",
      id: "create",
      label: t("files:git.moreMenu.tag.create"),
      disabled: tagDisabled,
      title: tagReason,
    },
    {
      kind: "item",
      id: "delete",
      label: t("files:git.moreMenu.tag.delete"),
      disabled: tagDisabled,
      title: tagReason,
    },
    {
      kind: "item",
      id: "delete-remote",
      label: t("files:git.moreMenu.tag.deleteRemote"),
      disabled: deleteRemoteAction.kind === "disabled",
      title: deleteRemoteAction.kind === "disabled" ? deleteRemoteAction.reason : undefined,
    },
    { kind: "separator", id: "before-push-tags" },
    {
      kind: "item",
      id: "push-tags",
      label: t("files:git.moreMenu.tag.pushTags"),
      disabled: pushTagsAction.kind === "disabled",
      title: pushTagsAction.kind === "disabled" ? pushTagsAction.reason : undefined,
    },
  ];
}

/** Formats the menu caption from FETCH_HEAD mtime. */
export function formatLastFetchedCaption(lastFetchedAt: number | null, now = Date.now()): string {
  const t = i18next.t.bind(i18next);
  if (lastFetchedAt === null) return t("files:git.moreMenu.autofetch.lastFetchedNever");
  const ageMs = Math.max(0, now - lastFetchedAt);
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return t("files:git.moreMenu.autofetch.lastFetchedJustNow");
  if (ageMin < 60) return t("files:git.moreMenu.autofetch.lastFetchedMinutes", { count: ageMin });
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return t("files:git.moreMenu.autofetch.lastFetchedHours", { count: ageHours });
  return t("files:git.moreMenu.autofetch.lastFetchedDays", { count: Math.floor(ageHours / 24) });
}
