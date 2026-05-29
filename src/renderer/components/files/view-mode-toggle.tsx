/**
 * ViewModeToggle — List/Tree segmented toggle button.
 *
 * Design contract:
 *  - Single icon button toggles list ↔ tree on each click.
 *  - aria-pressed=false in list mode, aria-pressed=true in tree mode.
 *  - Almost-monochromatic: only TOGGLE_ON_CLASS ring tokens, no new color tokens.
 *
 * Tooltip: handled via native `title=` on the Button. RadixTooltip was
 * removed because its Provider + PopperAnchor effect chain triggers an
 * infinite setState loop with React 19 (see radix-ui/primitives#3799). Other
 * call sites in this app already rely on `title=` for hover hints — aligning
 * here keeps that rule consistent and dodges the upstream bug.
 */

import { List, ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { Button } from "../ui/button";

export interface ViewModeToggleProps {
  viewMode: "list" | "tree";
  onViewModeChange: (next: "list" | "tree") => void;
  disabled?: boolean;
}

/**
 * Pure helper: given the current view mode, returns the mode to switch to on
 * a single toggle click. Exported so unit tests exercise the real logic.
 */
export function computeNextViewMode(current: "list" | "tree"): "list" | "tree" {
  return current === "tree" ? "list" : "tree";
}

// ON-state styling mirrors SearchOptionsToggles: inset ring distinguishes
// "pressed" from "hover" because ghost hover bg matches pressed bg alone.
const TOGGLE_ON_CLASS = "bg-[var(--state-active-bg)] text-foreground ring-1 ring-inset ring-ring";

export function ViewModeToggle({ viewMode, onViewModeChange, disabled = false }: ViewModeToggleProps) {
  const { t } = useTranslation("files");
  const isTree = viewMode === "tree";
  const toggleLabel = isTree ? t("search.viewMode.viewAsList") : t("search.viewMode.viewAsTree");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={toggleLabel}
      aria-pressed={isTree}
      title={toggleLabel}
      disabled={disabled}
      className={cn("shrink-0", isTree && TOGGLE_ON_CLASS)}
      onClick={() => onViewModeChange(computeNextViewMode(viewMode))}
    >
      {isTree ? <ListTree aria-hidden="true" /> : <List aria-hidden="true" />}
    </Button>
  );
}
