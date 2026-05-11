/**
 * GitMoreMenu — overflow menu for Source Control operations.
 *
 * Per-action enablement is driven by `RepoCapabilities` rather than a
 * single `disabled` flag so the user never reaches an action that would
 * fail with a raw stderr message:
 *
 *   - Stash      → requires hasHEAD (no commits → "no initial commit yet")
 *   - Stash Pop  → requires stashCount > 0 (else "No stash entries found")
 *   - Fetch/Pull → requires at least one configured remote
 *   - Push       → requires at least one configured remote (publishing
 *                  without an upstream is handled by a parent dialog, not
 *                  by hiding the menu item)
 *
 * Tooltips spell out the reason a disabled item is disabled so the user
 * knows what to do next without trial and error.
 *
 * All submenu flyout panels are rendered via React Portal (`document.body`)
 * with `position: fixed` coordinates so they escape any `overflow: hidden`
 * ancestor chain in the panel layout.  Outside-click containment uses
 * `useDismissOnOutsideClickWithMarker` with the `data-popover-root="git-more"`
 * attribute so portal nodes are correctly included in the "inside" region.
 */
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  RepoCapabilities,
} from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { useDismissOnOutsideClickWithMarker } from "../../ui/use-dismiss-on-outside-click";
import { useSubmenuPlacement } from "../../ui/use-submenu-placement";

/** Marker value shared by all portal panels in this menu. */
const PORTAL_MARKER = "git-more";

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

export type GitStashMenuItemId = "stash" | "stash-pop" | "open-stashes";

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

interface GitMoreMenuProps {
  disabled?: boolean;
  canInit?: boolean;
  hasChanges?: boolean;
  /** Repository-level capability flags. Falsy when the repo is detecting / non-repo. */
  capabilities?: RepoCapabilities;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onSwitchBranch: () => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
  onPushTags: (remote: string) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
  onDiscardAll: () => void;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
}

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

export function GitMoreMenu({
  disabled = false,
  canInit = false,
  hasChanges = false,
  capabilities,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onOpenStashes,
  onOpenTags,
  onSwitchBranch,
  onMergeBranch,
  onRebaseBranch,
  onCreateBranch,
  onCreateBranchFrom,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
  onPushTags,
  onAddRemote,
  onRemoveRemote,
  onDiscardAll,
  autofetchIntervalMin,
  lastFetchedAt,
  onSetAutofetchInterval,
}: GitMoreMenuProps) {
  const [open, setOpen] = useState(false);
  // Only one top-level submenu can be open at a time so clicking a sibling
  // trigger swaps the open flyout instead of stacking two side-by-side.
  const [openL1, setOpenL1] = useState<GitMoreL1Submenu | null>(null);
  const [removeRemoteOpen, setRemoveRemoteOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setOpenL1(null);
    setRemoveRemoteOpen(false);
  }, []);
  const handleL1OpenChange = useCallback(
    (kind: GitMoreL1Submenu) => (next: boolean) => {
      setOpenL1(next ? kind : (prev) => (prev === kind ? null : prev));
      // Closing the parent submenu naturally closes any nested L2 panel
      // because TagSubmenu owns its own L2 state and resets on close.
      if (!next) setRemoveRemoteOpen(false);
    },
    [],
  );

  // Use the marker-aware dismiss hook so portal panels (which live outside
  // wrapperRef in the DOM) are treated as "inside" and do not trigger close.
  useDismissOnOutsideClickWithMarker(wrapperRef, open, close, PORTAL_MARKER);

  function run(action: () => void): void {
    close();
    action();
  }

  const repoBusy = disabled || canInit;
  const remotes = capabilities?.remotes ?? [];
  const hasRemote = (capabilities?.remotes.length ?? 0) > 0;
  const hasHead = capabilities?.hasHEAD ?? false;
  const stashCount = capabilities?.stashCount ?? 0;

  // Disable reasons documented as tooltips so screen readers and hover
  // surfaces explain the gating; an enabled action falls back to its label.
  const fetchReason = hasRemote ? null : "Add a remote first.";
  const pullReason = hasRemote ? null : "Add a remote first.";
  const pushReason = hasRemote ? null : "Add a remote first.";

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label="More source control actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <MenuButton label="Refresh" onClick={() => run(onRefresh)} disabled={disabled} />
          {canInit ? (
            <MenuButton
              label="Initialize Repository"
              onClick={() => run(onInit)}
              disabled={disabled}
            />
          ) : null}
          <MenuSeparator />
          <MenuButton
            label="Fetch"
            onClick={() => run(onFetch)}
            disabled={repoBusy || !hasRemote}
            title={fetchReason ?? undefined}
          />
          <MenuButton
            label="Pull"
            onClick={() => run(onPull)}
            disabled={repoBusy || !hasRemote}
            title={pullReason ?? undefined}
          />
          <MenuButton
            label="Push"
            onClick={() => run(onPush)}
            disabled={repoBusy || !hasRemote}
            title={pushReason ?? undefined}
          />
          <MenuSeparator />
          <MenuButton
            label="Checkout to…"
            onClick={() => run(onSwitchBranch)}
            disabled={repoBusy}
          />
          <BranchSubmenu
            open={openL1 === "branch"}
            disabled={repoBusy}
            hasHead={hasHead}
            onOpenChange={handleL1OpenChange("branch")}
            onMergeBranch={() => run(onMergeBranch)}
            onRebaseBranch={() => run(onRebaseBranch)}
            onCreateBranch={() => run(onCreateBranch)}
            onCreateBranchFrom={() => run(onCreateBranchFrom)}
            onRenameBranch={() => run(onRenameBranch)}
            onDeleteBranch={() => run(onDeleteBranch)}
            onDeleteRemoteBranch={() => run(onDeleteRemoteBranch)}
          />
          <RemotesSubmenu
            open={openL1 === "remote"}
            removeOpen={removeRemoteOpen}
            remotes={remotes}
            disabled={repoBusy}
            onOpenChange={handleL1OpenChange("remote")}
            onRemoveOpenChange={setRemoveRemoteOpen}
            onAddRemote={() => run(onAddRemote)}
            onRemoveRemote={(remote) => run(() => onRemoveRemote(remote))}
          />
          <StashSubmenu
            open={openL1 === "stash"}
            disabled={repoBusy}
            hasHead={hasHead}
            stashCount={stashCount}
            onOpenChange={handleL1OpenChange("stash")}
            onStash={() => run(onStash)}
            onStashPop={() => run(onStashPop)}
            onOpenStashes={() => run(onOpenStashes)}
          />
          <TagSubmenu
            open={openL1 === "tag"}
            disabled={repoBusy}
            hasHead={hasHead}
            remotes={remotes}
            onOpenChange={handleL1OpenChange("tag")}
            onOpenTags={(mode, remote) => run(() => onOpenTags(mode, remote))}
            onPushTags={(remote) => run(() => onPushTags(remote))}
          />
          <MenuSeparator />
          <AutofetchSubmenu
            open={openL1 === "autofetch"}
            selected={autofetchIntervalMin}
            lastFetchedAt={lastFetchedAt}
            disabled={disabled}
            onOpenChange={handleL1OpenChange("autofetch")}
            onSelect={(intervalMin) => run(() => onSetAutofetchInterval(intervalMin))}
          />
          <MenuSeparator />
          <MenuButton
            label="Discard All Changes"
            onClick={() => run(onDiscardAll)}
            disabled={repoBusy || !hasChanges}
            destructive
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders the Branch flyout with wired workflow/create entries and disabled
 * gating for actions that require a real HEAD.
 */
function BranchSubmenu({
  open,
  disabled,
  hasHead,
  onOpenChange,
  onMergeBranch,
  onRebaseBranch,
  onCreateBranch,
  onCreateBranchFrom,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  onOpenChange: (open: boolean) => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
}) {
  const model = buildGitBranchMenuModel({ disabled, hasHead });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);
  const handlers: GitBranchMenuActionHandlers = {
    onMergeBranch,
    onRebaseBranch,
    onCreateBranch,
    onCreateBranchFrom,
    onRenameBranch,
    onDeleteBranch,
    onDeleteRemoteBranch,
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Branch</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[220px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {model.map((item) =>
                item.kind === "separator" ? (
                  <MenuSeparator key={item.id} />
                ) : (
                  <MenuButton
                    key={item.id}
                    label={item.label}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => runGitBranchMenuAction(item.id, handlers)}
                  />
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders the Stash flyout around the existing stash commands.
 */
function StashSubmenu({
  open,
  disabled,
  hasHead,
  stashCount,
  onOpenChange,
  onStash,
  onStashPop,
  onOpenStashes,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  stashCount: number;
  onOpenChange: (open: boolean) => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
}) {
  const model = buildGitStashMenuModel({ disabled, hasHead, stashCount });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  function select(id: GitStashMenuItemId): void {
    switch (id) {
      case "stash":
        onStash();
        return;
      case "stash-pop":
        onStashPop();
        return;
      case "open-stashes":
        onOpenStashes();
        return;
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Stash</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[188px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {model.map((item) =>
                item.kind === "separator" ? (
                  <MenuSeparator key="stash-separator" />
                ) : (
                  <MenuButton
                    key={item.id}
                    label={item.label}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => select(item.id)}
                  />
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Renders the Tag flyout and routes entries into their picker modes. */
function TagSubmenu({
  open,
  disabled,
  hasHead,
  remotes,
  onOpenChange,
  onOpenTags,
  onPushTags,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onPushTags: (remote: string) => void;
}) {
  const model = buildGitTagMenuModel({ disabled, hasHead, remotes });
  const deleteRemoteTagAction = resolveGitDeleteRemoteTagAction({ disabled, hasHead, remotes });
  const pushTagsAction = resolveGitPushTagsAction({ disabled, hasHead, remotes });
  // Mirror the top-level rule: only one Tag-level remote picker open at a time.
  const [openL2, setOpenL2] = useState<"delete-remote" | "push-tags" | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);
  const tagHandlers: GitTagMenuActionHandlers = { onOpenTags };
  const handleL2OpenChange = useCallback(
    (kind: "delete-remote" | "push-tags") => (next: boolean) => {
      setOpenL2(next ? kind : (prev) => (prev === kind ? null : prev));
    },
    [],
  );

  useEffect(() => {
    if (!open) setOpenL2(null);
  }, [open]);

  function select(id: GitTagMenuItemId): void {
    if (id === "delete-remote" && deleteRemoteTagAction.kind === "open-picker") {
      runGitTagMenuAction(id, tagHandlers, deleteRemoteTagAction.remote);
      return;
    }
    if (id === "push-tags" && pushTagsAction.kind === "push") {
      onPushTags(pushTagsAction.remote);
      return;
    }
    if (id !== "push-tags") runGitTagMenuAction(id, tagHandlers);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Tag</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[188px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {model.map((item) =>
                item.kind === "separator" ? (
                  <MenuSeparator key={item.id} />
                ) : item.id === "delete-remote" &&
                  deleteRemoteTagAction.kind === "choose-remote" ? (
                  <DeleteRemoteTagRemoteSubmenu
                    key={item.id}
                    open={openL2 === "delete-remote"}
                    remotes={deleteRemoteTagAction.remotes}
                    onOpenChange={handleL2OpenChange("delete-remote")}
                    onOpenTags={onOpenTags}
                  />
                ) : item.id === "push-tags" && pushTagsAction.kind === "choose-remote" ? (
                  <PushTagsRemoteSubmenu
                    key={item.id}
                    open={openL2 === "push-tags"}
                    remotes={pushTagsAction.remotes}
                    onOpenChange={handleL2OpenChange("push-tags")}
                    onPushTags={onPushTags}
                  />
                ) : (
                  <MenuButton
                    key={item.id}
                    label={item.label}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => select(item.id)}
                  />
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders the Delete Remote Tag multi-remote chooser nested under Tag.
 */
function DeleteRemoteTagRemoteSubmenu({
  open,
  remotes,
  onOpenChange,
  onOpenTags,
}: {
  open: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Delete Remote Tag…</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[152px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {remotes.map((remote) => (
                <MenuButton
                  key={remote}
                  label={remote}
                  onClick={() => onOpenTags("delete-remote", remote)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders the Push Tags multi-remote chooser nested under the Tag flyout.
 */
function PushTagsRemoteSubmenu({
  open,
  remotes,
  onOpenChange,
  onPushTags,
}: {
  open: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onPushTags: (remote: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Push Tags</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[152px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {remotes.map((remote) => (
                <MenuButton key={remote} label={remote} onClick={() => onPushTags(remote)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders the Remote flyout with read-only current remotes plus add/remove
 * actions. Removal has its own nested picker so the user explicitly selects
 * which remote to delete before the confirmation dialog appears.
 */
function RemotesSubmenu({
  open,
  removeOpen,
  remotes,
  disabled,
  onOpenChange,
  onRemoveOpenChange,
  onAddRemote,
  onRemoveRemote,
}: {
  open: boolean;
  removeOpen: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveOpenChange: (open: boolean) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const model = buildGitRemotesMenuModel(remotes);
  const currentRemotes = model.filter((item) => item.kind === "remote" || item.kind === "empty");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Remote</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              <div className="max-h-[40vh] overflow-y-auto">
                {currentRemotes.map((item) =>
                  item.kind === "remote" ? (
                    <RemoteLabel key={item.remote} label={item.label} />
                  ) : (
                    <RemoteLabel key="empty" label={item.label} muted />
                  ),
                )}
              </div>
              <MenuSeparator />
              <MenuButton label="Add remote…" onClick={onAddRemote} disabled={disabled} />
              <RemoveRemoteSubmenu
                open={removeOpen}
                remotes={remotes}
                disabled={disabled || remotes.length === 0}
                onOpenChange={onRemoveOpenChange}
                onRemoveRemote={onRemoveRemote}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Renders the Autofetch cadence flyout plus last-fetched caption. */
function AutofetchSubmenu({
  open,
  selected,
  lastFetchedAt,
  disabled,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  selected: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (intervalMin: GitAutofetchIntervalMin) => void;
}) {
  const model = buildAutofetchMenuModel(selected);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Autofetch</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[188px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {model.map((item) => (
                <MenuButton
                  key={item.intervalMin}
                  label={`${item.selected ? "✓ " : ""}${item.label}`}
                  onClick={() => onSelect(item.intervalMin)}
                />
              ))}
              <MenuSeparator />
              <div className="px-2 py-1 text-app-ui-sm text-muted-foreground">
                {formatLastFetchedCaption(lastFetchedAt)}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders a non-clickable current-remote row in the Remotes submenu.
 */
function RemoteLabel({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <div
      className={
        muted
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-muted-foreground"
          : "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground"
      }
    >
      {label}
    </div>
  );
}

/**
 * Renders the remove-remote picker nested under the Remotes flyout.
 * This component is rendered inside the RemotesSubmenu portal, so it does
 * NOT need its own portal — it is already in the body-level stacking context.
 * Its nested submenu panel IS portaled separately.
 */
function RemoveRemoteSubmenu({
  open,
  remotes,
  disabled,
  onOpenChange,
  onRemoveRemote,
}: {
  open: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={remotes.length === 0 ? "No remotes configured." : undefined}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Remove remote…</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[152px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {remotes.map((remote) => (
                <MenuButton key={remote} label={remote} onClick={() => onRemoveRemote(remote)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  destructive,
  title,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={
        destructive
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm git-destructive-text hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          : "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-mist-border" />;
}
