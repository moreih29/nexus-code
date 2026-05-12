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
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { useDismissOnOutsideClickWithMarker } from "../../ui/use-dismiss-on-outside-click";
import { useSubmenuPlacement } from "../../ui/use-submenu-placement";
import {
  buildAutofetchMenuModel,
  buildGitBranchMenuModel,
  buildGitRemotesMenuModel,
  buildGitStashMenuModel,
  buildGitTagMenuModel,
  formatLastFetchedCaption,
  type GitBranchMenuActionHandlers,
  type GitMoreL1Submenu,
  type GitStashMenuItemId,
  type GitTagMenuActionHandlers,
  type GitTagMenuItemId,
  type GitTagPickerMenuMode,
  resolveGitDeleteRemoteTagAction,
  resolveGitPushTagsAction,
  runGitBranchMenuAction,
  runGitTagMenuAction,
} from "./git-more-menu-model";

/** Marker value shared by all portal panels in this menu. */
const PORTAL_MARKER = "git-more";

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
  onDropStash: () => void;
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
  onDropStash,
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
            onDropStash={() => run(onDropStash)}
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
  onDropStash,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  stashCount: number;
  onOpenChange: (open: boolean) => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onDropStash: () => void;
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
      case "drop-stash":
        onDropStash();
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
