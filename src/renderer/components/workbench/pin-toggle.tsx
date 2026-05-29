/**
 * PinToggle — workspace sidebar row toggle button for pinning/unpinning.
 *
 * Visual contract:
 *   - pinned=true  → always visible, filled Pin icon, accent color, aria-pressed=true
 *   - pinned=false → hidden at rest, revealed on row hover or keyboard focus,
 *                    outlined Pin icon, muted color, aria-pressed=false
 *
 * Must be placed inside a `.group` ancestor so the group-hover reveal works.
 * Click event is stopped from propagating so the parent row-select button
 * does not fire when the pin is clicked.
 */

import { Pin } from "lucide-react";
import { Tooltip as RadixTooltip } from "radix-ui";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { UI_TOOLTIP_DELAY_MS } from "../../../shared/util/timing-constants";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PinToggleProps {
  /** Current pinned state of the workspace. */
  pinned: boolean;
  /** Workspace display name — used in the aria-label. */
  workspaceName: string;
  /** Called when the user activates the button (click or keyboard). */
  onToggle: () => void;
  /**
   * When false, sets draggable="false" on the underlying button so that a
   * mousedown on this button never initiates a drag of the parent row.
   * Defaults to undefined (browser default behavior).
   */
  draggable?: false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a Pin icon button that toggles workspace pin state.
 * Integrates with the Radix Tooltip provider expected to be present in
 * the sidebar's RadixTooltip.Provider wrapper.
 */
export function PinToggle({ pinned, workspaceName, onToggle, draggable }: PinToggleProps) {
  const { t } = useTranslation();
  const tooltipLabel = pinned ? t("sidebar.unpin") : t("sidebar.pin_to_top");
  const ariaLabel = pinned
    ? t("sidebar.unpin_workspace_aria", { name: workspaceName })
    : t("sidebar.pin_workspace_aria", { name: workspaceName });

  function handleClick(e: React.MouseEvent) {
    // Prevent the parent workspace-select button from receiving the click.
    e.stopPropagation();
    onToggle();
  }

  return (
    <RadixTooltip.Root delayDuration={UI_TOOLTIP_DELAY_MS}>
      <RadixTooltip.Trigger asChild>
        <button
          type="button"
          draggable={draggable}
          aria-pressed={pinned}
          aria-label={ariaLabel}
          onClick={handleClick}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 right-9",
            "inline-flex items-center justify-center",
            "size-5 rounded-(--radius-control)",
            "transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            pinned
              ? // Always visible when pinned; filled icon; accent color.
                "opacity-100 text-[var(--state-selected-indicator)]"
              : // Hidden at rest; revealed on row hover or keyboard focus.
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground",
          )}
        >
          <Pin
            className="size-3"
            // Filled icon signals the pinned state; outlined icon signals unpinned.
            fill={pinned ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="px-2 py-1 text-app-micro bg-muted text-foreground border border-border rounded-(--radius-control) shadow-none"
          sideOffset={4}
        >
          {tooltipLabel}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
