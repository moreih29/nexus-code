/**
 * GitMoreMenu provides simple Source Control overflow operations.
 */
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";

interface GitMoreMenuProps {
  disabled?: boolean;
  canInit?: boolean;
  hasChanges?: boolean;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onCheckout: () => void;
  onCreateBranch: () => void;
  onDiscardAll: () => void;
}

export function GitMoreMenu({
  disabled = false,
  canInit = false,
  hasChanges = false,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onCheckout,
  onCreateBranch,
  onDiscardAll,
}: GitMoreMenuProps) {
  const [open, setOpen] = useState(false);

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  return (
    <div className="relative">
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
          <MenuButton label="Fetch" onClick={() => run(onFetch)} disabled={disabled || canInit} />
          <MenuButton label="Pull" onClick={() => run(onPull)} disabled={disabled || canInit} />
          <MenuButton label="Push" onClick={() => run(onPush)} disabled={disabled || canInit} />
          <MenuSeparator />
          <MenuButton
            label="Checkout…"
            onClick={() => run(onCheckout)}
            disabled={disabled || canInit}
          />
          <MenuButton
            label="Create Branch…"
            onClick={() => run(onCreateBranch)}
            disabled={disabled || canInit}
          />
          <MenuSeparator />
          <MenuButton label="Stash" onClick={() => run(onStash)} disabled={disabled || canInit} />
          <MenuButton
            label="Stash Pop"
            onClick={() => run(onStashPop)}
            disabled={disabled || canInit}
          />
          <MenuSeparator />
          <MenuButton
            label="Discard All Changes"
            onClick={() => run(onDiscardAll)}
            disabled={disabled || canInit || !hasChanges}
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
  onClick,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
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
