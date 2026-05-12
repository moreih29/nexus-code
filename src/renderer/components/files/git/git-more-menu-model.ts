/**
 * Pure data models for the More menu — submenu shells, action discriminators,
 * and the small format/run helpers that drive them.
 *
 * Splitting these out of `GitMoreMenu.tsx` lets the renderer component focus
 * on portal placement, focus management, and event wiring while leaving the
 * "what does each menu entry look like, and when is it disabled?" logic in
 * one inspectable, test-only file. Every function here is side-effect free.
 */

import type { BranchInfo, GitAutofetchIntervalMin } from "../../../../shared/types/git";

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
  const currentRemotes: GitRemotesMenuSpec[] =
    remotes.length > 0
      ? remotes.map((remote) => ({ kind: "remote", remote, label: remote }))
      : [{ kind: "empty", label: "No remotes configured" }];
  return [
    ...currentRemotes,
    { kind: "action", id: "add-remote", label: "Add remote…" },
    {
      kind: "action",
      id: "remove-remote",
      label: "Remove remote…",
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
  return `${branch.current} tracks ${remote}/... Removing detaches upstream tracking.`;
}

/** Builds the fixed Autofetch submenu options, marking the selected interval. */
export function buildAutofetchMenuModel(
  selected: GitAutofetchIntervalMin,
): GitAutofetchMenuOption[] {
  return [
    { intervalMin: 0, label: "Off", selected: selected === 0 },
    { intervalMin: 3, label: "Every 3 min", selected: selected === 3 },
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
  return [
    { kind: "item", label: "Refresh" },
    ...(canInit ? [{ kind: "item" as const, label: "Initialize Repository" }] : []),
    { kind: "separator", id: "after-refresh" },
    { kind: "item", label: "Fetch" },
    { kind: "item", label: "Pull" },
    { kind: "item", label: "Push" },
    { kind: "separator", id: "after-sync" },
    { kind: "item", label: "Checkout to…" },
    { kind: "submenu", label: "Branch" },
    { kind: "submenu", label: "Remote" },
    { kind: "submenu", label: "Stash" },
    { kind: "submenu", label: "Tag" },
    { kind: "separator", id: "after-refs" },
    { kind: "submenu", label: "Autofetch" },
    { kind: "separator", id: "after-autofetch" },
    { kind: "item", label: "Discard All Changes", destructive: true },
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
  const workflowDisabled = disabled || !hasHead;
  const workflowReason = hasHead ? undefined : "Make an initial commit first.";
  return [
    {
      kind: "item",
      id: "merge",
      label: "Merge Branch…",
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "rebase",
      label: "Rebase Current Branch…",
      disabled: workflowDisabled,
      title: workflowReason,
    },
    { kind: "separator", id: "after-workflow" },
    {
      kind: "item",
      id: "create",
      label: "Create New Branch…",
      disabled,
    },
    {
      kind: "item",
      id: "create-from",
      label: "Create New Branch From…",
      disabled,
    },
    { kind: "separator", id: "after-create" },
    {
      kind: "item",
      id: "rename",
      label: "Rename Branch…",
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "delete",
      label: "Delete Branch…",
      disabled: workflowDisabled,
      title: workflowReason,
    },
    {
      kind: "item",
      id: "delete-remote",
      label: "Delete Remote Branch…",
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
  const stashReason = hasHead ? undefined : "Make an initial commit first.";
  const stashPopReason =
    stashCount === 0 ? "Stash is empty." : !hasHead ? "Make an initial commit first." : undefined;
  const dropStashReason =
    stashCount === 0 ? "Stash is empty." : !hasHead ? "Make an initial commit first." : undefined;
  return [
    {
      kind: "item",
      id: "stash",
      label: "Stash",
      disabled: disabled || !hasHead,
      title: stashReason,
    },
    {
      kind: "item",
      id: "stash-pop",
      label: "Stash Pop",
      disabled: disabled || stashCount === 0 || !hasHead,
      title: stashPopReason,
    },
    {
      kind: "item",
      id: "open-stashes",
      label: "Stashes…",
      disabled: disabled || !hasHead,
      title: stashReason,
    },
    { kind: "separator", id: "before-drop-stash" },
    {
      kind: "item",
      id: "drop-stash",
      label: "Drop Stash…",
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
  if (remotes.length === 0) return { kind: "disabled", reason: "No remotes configured" };
  if (disabled) return { kind: "disabled", reason: "Repository is busy." };
  if (!hasHead) return { kind: "disabled", reason: "Make an initial commit first." };
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
  if (remotes.length === 0) return { kind: "disabled", reason: "No remotes configured" };
  if (disabled) return { kind: "disabled", reason: "Repository is busy." };
  if (!hasHead) return { kind: "disabled", reason: "Make an initial commit first." };
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
  const tagDisabled = disabled || !hasHead;
  const tagReason = hasHead ? undefined : "Make an initial commit first.";
  const deleteRemoteAction = resolveGitDeleteRemoteTagAction({ disabled, hasHead, remotes });
  const pushTagsAction = resolveGitPushTagsAction({ disabled, hasHead, remotes });
  return [
    {
      kind: "item",
      id: "create",
      label: "Create Tag…",
      disabled: tagDisabled,
      title: tagReason,
    },
    {
      kind: "item",
      id: "delete",
      label: "Delete Tag…",
      disabled: tagDisabled,
      title: tagReason,
    },
    {
      kind: "item",
      id: "delete-remote",
      label: "Delete Remote Tag…",
      disabled: deleteRemoteAction.kind === "disabled",
      title: deleteRemoteAction.kind === "disabled" ? deleteRemoteAction.reason : undefined,
    },
    { kind: "separator", id: "before-push-tags" },
    {
      kind: "item",
      id: "push-tags",
      label: "Push Tags",
      disabled: pushTagsAction.kind === "disabled",
      title: pushTagsAction.kind === "disabled" ? pushTagsAction.reason : undefined,
    },
  ];
}

/** Formats the menu caption from FETCH_HEAD mtime. */
export function formatLastFetchedCaption(lastFetchedAt: number | null, now = Date.now()): string {
  if (lastFetchedAt === null) return "Last fetched never";
  const ageMs = Math.max(0, now - lastFetchedAt);
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return "Last fetched just now";
  if (ageMin < 60) return `Last fetched ${ageMin}m ago`;
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return `Last fetched ${ageHours}h ago`;
  return `Last fetched ${Math.floor(ageHours / 24)}d ago`;
}
