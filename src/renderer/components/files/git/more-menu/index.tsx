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
 * ancestor chain in the panel layout. Outside-click containment uses
 * `useDismissOnOutsideClickWithMarker` with the `data-popover-root="git-more"`
 * attribute so portal nodes are correctly included in the "inside" region.
 *
 * Each top-level flyout (Branch/Stash/Tag/Remotes/Autofetch) lives in its
 * own file under `./git-more-menu/` so this view stays focused on the
 * top-level menu, props plumbing, and open-state coordination.
 */
import { MoreHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { useDismissOnOutsideClickWithMarker } from "../../../ui/use-dismiss-on-outside-click";
import { AutofetchSubmenu } from "./autofetch-submenu";
import { BranchSubmenu } from "./branch-submenu";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";
import { RemotesSubmenu } from "./remotes-submenu";
import { StashSubmenu } from "./stash-submenu";
import { TagSubmenu } from "./tag-submenu";
import type { GitMoreL1Submenu, GitTagPickerMenuMode } from "../utils/more-menu-model";

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
  const { t } = useTranslation("files");
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
  const fetchReason = hasRemote ? null : t("git.moreMenu.addRemoteFirst");
  const pullReason = hasRemote ? null : t("git.moreMenu.addRemoteFirst");
  const pushReason = hasRemote ? null : t("git.moreMenu.addRemoteFirst");

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={t("git.panel.header.moreActions")}
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
          className="absolute right-0 top-8 z-40 min-w-[188px] floating-panel p-1"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <MenuButton label={t("git.moreMenu.refresh")} onClick={() => run(onRefresh)} disabled={disabled} />
          {canInit ? (
            <MenuButton
              label={t("git.moreMenu.initRepo")}
              onClick={() => run(onInit)}
              disabled={disabled}
            />
          ) : null}
          <MenuSeparator />
          <MenuButton
            label={t("git.moreMenu.fetch")}
            onClick={() => run(onFetch)}
            disabled={repoBusy || !hasRemote}
            title={fetchReason ?? undefined}
          />
          <MenuButton
            label={t("git.moreMenu.pull")}
            onClick={() => run(onPull)}
            disabled={repoBusy || !hasRemote}
            title={pullReason ?? undefined}
          />
          <MenuButton
            label={t("git.moreMenu.push")}
            onClick={() => run(onPush)}
            disabled={repoBusy || !hasRemote}
            title={pushReason ?? undefined}
          />
          <MenuSeparator />
          <MenuButton
            label={t("git.moreMenu.checkoutTo")}
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
            label={t("git.moreMenu.discardAllChanges")}
            onClick={() => run(onDiscardAll)}
            disabled={repoBusy || !hasChanges}
            destructive
          />
        </div>
      ) : null}
    </div>
  );
}
