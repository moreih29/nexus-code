/**
 * "+N" after a strip of tabs that runs on out of sight: a menu of the tabs
 * not wholly shown. Picking one brings it to the front, where the strip
 * scrolls to it, and the pick moves the keyboard into it.
 */

import { ChevronDown } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { tooltipProps } from "../../ui/tooltip";

export function OverflowTabsMenu({
  hidden,
  renderTab,
  onSelect,
}: {
  /** The tabs out of sight, in strip order. */
  hidden: readonly string[];
  /** A tab's row in the menu: its icon and title. */
  renderTab: (id: string) => ReactNode;
  /** Brings the tab to the front and the keyboard into it. */
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  // Set on a pick, whose tab takes the keyboard: the menu must not hand it
  // back to this button as it closes.
  const picked = useRef(false);
  if (hidden.length === 0) return null;
  const label = t("tabBar.hidden_tabs", { count: hidden.length });
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label={label}
          {...tooltipProps(label)}
          className={cn(
            "flex h-6 shrink-0 items-center gap-0.5 rounded-(--radius-control) px-1.5",
            "text-app-ui-sm text-muted-foreground tabular-nums transition-colors",
            "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            "data-[state=open]:bg-[var(--state-active-bg)] data-[state=open]:text-foreground",
          )}
        >
          +{hidden.length}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!picked.current) return;
          picked.current = false;
          event.preventDefault();
        }}
      >
        {hidden.map((id) => (
          <DropdownMenuItem
            key={id}
            onSelect={() => {
              picked.current = true;
              onSelect(id);
            }}
          >
            <span className="flex min-w-0 max-w-80 items-center gap-1.5">{renderTab(id)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
