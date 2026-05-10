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
 */
import { MoreHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { RepoCapabilities } from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { useDismissOnOutsideClick } from "../../ui/use-dismiss-on-outside-click";

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
  onSwitchBranch: () => void;
  onDiscardAll: () => void;
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
  onSwitchBranch,
  onDiscardAll,
}: GitMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick(wrapperRef, open, close);

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  const repoBusy = disabled || canInit;
  const hasRemote = (capabilities?.remotes.length ?? 0) > 0;
  const hasHead = capabilities?.hasHEAD ?? false;
  const stashCount = capabilities?.stashCount ?? 0;

  // Disable reasons documented as tooltips so screen readers and hover
  // surfaces explain the gating; an enabled action falls back to its label.
  const fetchReason = hasRemote ? null : "Add a remote first.";
  const pullReason = hasRemote ? null : "Add a remote first.";
  const pushReason = hasRemote ? null : "Add a remote first.";
  const stashReason = hasHead ? null : "Make an initial commit first.";
  const stashPopReason =
    stashCount === 0 ? "Stash is empty." : !hasHead ? "Make an initial commit first." : null;

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
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
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
          <MenuSeparator />
          <MenuButton
            label="Stash"
            onClick={() => run(onStash)}
            disabled={repoBusy || !hasHead}
            title={stashReason ?? undefined}
          />
          <MenuButton
            label="Stash Pop"
            onClick={() => run(onStashPop)}
            disabled={repoBusy || stashCount === 0 || !hasHead}
            title={stashPopReason ?? undefined}
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
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-destructive hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
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
