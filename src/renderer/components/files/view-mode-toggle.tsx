/**
 * ViewModeToggle — List/Tree segmented toggle with optional Compact Folders popover.
 *
 * Design contract:
 *  - Single icon button toggles list ↔ tree on each click.
 *  - aria-pressed=false in list mode, aria-pressed=true in tree mode.
 *  - When compactFolders/onCompactChange are provided, a ChevronDown split
 *    trigger opens a popover with a single checkable "Compact folders" item.
 *  - When both compact props are undefined the split trigger is not rendered.
 *  - Almost-monochromatic: only TOGGLE_ON_CLASS ring tokens, no new color tokens.
 */

import { ChevronDown, List, ListTree } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { Button } from "../ui/button";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

export interface ViewModeToggleProps {
  viewMode: "list" | "tree";
  onViewModeChange: (next: "list" | "tree") => void;
  compactFolders?: boolean;
  onCompactChange?: (next: boolean) => void;
  disabled?: boolean;
}

/**
 * Pure helper: given the current view mode, returns the mode to switch to on
 * a single toggle click. Exported so unit tests exercise the real logic.
 */
export function computeNextViewMode(current: "list" | "tree"): "list" | "tree" {
  return current === "tree" ? "list" : "tree";
}

/**
 * Pure helper: given the current compact-folders flag, returns the toggled
 * value. Exported so unit tests exercise the real logic.
 */
export function computeNextCompact(current: boolean): boolean {
  return !current;
}

// ON-state styling mirrors SearchOptionsToggles: inset ring distinguishes
// "pressed" from "hover" because ghost hover bg matches pressed bg alone.
const TOGGLE_ON_CLASS = "bg-[var(--state-active-bg)] text-foreground ring-1 ring-inset ring-ring";

export function ViewModeToggle({
  viewMode,
  onViewModeChange,
  compactFolders,
  onCompactChange,
  disabled = false,
}: ViewModeToggleProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const compactWrapperRef = useRef<HTMLDivElement>(null);
  const closePopover = useCallback(() => setPopoverOpen(false), []);
  useDismissOnOutsideClick(compactWrapperRef, popoverOpen, closePopover);

  const isTree = viewMode === "tree";
  const hasCompact = compactFolders !== undefined && onCompactChange !== undefined;

  const toggleLabel = isTree ? "View as List" : "View as Tree";

  function handleToggle() {
    onViewModeChange(computeNextViewMode(viewMode));
  }

  // Tooltip: handled via native `title=` on each Button. We previously wrapped
  // these in `<RadixTooltip.Trigger asChild>` for styling consistency, but
  // radix-ui's Tooltip + PopperAnchor effect chain triggers an infinite
  // setState loop with React 19 (see radix-ui/primitives#3799 family). Other
  // call sites in this app already rely on `title=` for hover hints — aligning
  // here keeps that one rule consistent and dodges the upstream bug.
  return (
    <div className="relative flex items-center">
      {/* ── Main toggle button ── */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={toggleLabel}
        aria-pressed={isTree}
        title={toggleLabel}
        disabled={disabled}
        className={cn(
          "shrink-0",
          // When compact split is present, square off the right edge so
          // the two buttons read as a joined group.
          hasCompact && "rounded-r-none",
          isTree && TOGGLE_ON_CLASS,
        )}
        onClick={handleToggle}
      >
        {isTree ? <ListTree aria-hidden="true" /> : <List aria-hidden="true" />}
      </Button>

      {/* ── Compact folders split trigger — only when both props provided ── */}
      {hasCompact ? (
        <div className="relative" ref={compactWrapperRef}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Compact folders options"
            aria-haspopup="menu"
            aria-expanded={popoverOpen}
            title="Compact folders"
            disabled={disabled}
            className={cn("shrink-0 w-4 rounded-l-none px-0", compactFolders && TOGGLE_ON_CLASS)}
            onClick={() => setPopoverOpen((prev) => !prev)}
          >
            <ChevronDown className="size-3" aria-hidden="true" />
            <span className="sr-only">Compact folders</span>
          </Button>

          {/* ── Compact popover ── */}
          {popoverOpen ? (
            <div
              role="menu"
              aria-label="View options"
              className="absolute right-0 top-9 z-40 min-w-[188px] floating-panel p-1"
              onKeyDown={(event) => {
                if (event.key === "Escape") setPopoverOpen(false);
              }}
            >
              <CompactMenuItem
                checked={!!compactFolders}
                onToggle={() => {
                  onCompactChange(computeNextCompact(!!compactFolders));
                  setPopoverOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Internal menu item ──────────────────────────────────────────────────────

interface CompactMenuItemProps {
  checked: boolean;
  onToggle: () => void;
}

function CompactMenuItem({ checked, onToggle }: CompactMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      onClick={onToggle}
    >
      {/* Checkmark placeholder — always present in layout to avoid text jump */}
      <span className="size-3.5 shrink-0 flex items-center justify-center" aria-hidden="true">
        {checked ? (
          // Inline SVG check mark keeps the dep count minimal (no extra lucide import for a 3px glyph)
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3"
          >
            <polyline points="2,6 5,9 10,3" />
          </svg>
        ) : null}
      </span>
      <span>Compact folders</span>
    </button>
  );
}
