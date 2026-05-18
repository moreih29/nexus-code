/**
 * Autofetch interval picker for GitMoreMenu, with the last-fetched caption
 * rendered as a non-interactive footer so the user can sanity-check that
 * cron is actually firing.
 */
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import type { GitAutofetchIntervalMin } from "../../../../../shared/git/types";
import { useSubmenuPlacement } from "../../../ui/use-submenu-placement";
import {
  buildAutofetchMenuModel,
  formatLastFetchedCaption,
} from "../utils/git-more-menu-model";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";

export function AutofetchSubmenu({
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
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
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
              className="z-50 max-h-[40vh] min-w-[188px] overflow-y-auto rounded border border-border bg-popover p-1 text-popover-foreground shadow-none"
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
