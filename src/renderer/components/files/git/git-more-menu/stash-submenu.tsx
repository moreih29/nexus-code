/**
 * Stash flyout for GitMoreMenu. The model decides which entries are visible
 * and which are disabled (stash count, HEAD presence); this view only routes
 * the resulting click onto the matching handler.
 */
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useSubmenuPlacement } from "../../../ui/use-submenu-placement";
import { buildGitStashMenuModel, type GitStashMenuItemId } from "../utils/git-more-menu-model";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";

export function StashSubmenu({
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
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
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
              className="floating-panel z-50 max-h-[40vh] min-w-[188px] overflow-y-auto p-1"
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
