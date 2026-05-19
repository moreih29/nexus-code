/**
 * ExpandCollapseButtons — paired Expand-All / Collapse-All toolbar buttons.
 *
 * Shared between the file-tree panel and the git Source Control panel; both
 * panels want the same affordance ("flatten" everything visible, or "open up"
 * everything visible) so the component lives in the panel-neutral `files/`
 * folder rather than under either consumer.
 *
 * Visual style mirrors the old ViewModeToggle split-trigger: two adjacent
 * ghost icon-sm buttons with the inner edges squared off so they read as a
 * single segmented control. Native `title=` provides the tooltip — RadixTooltip
 * is avoided across this codebase because of the React 19 ref-loop hazard
 * documented in `view-mode-toggle.tsx`.
 */

import { FoldVertical, UnfoldVertical } from "lucide-react";
import { Button } from "../ui/button";

export interface ExpandCollapseButtonsProps {
  onExpand: () => void;
  onCollapse: () => void;
  /** Disables both buttons together (e.g. while a panel is loading). */
  disabled?: boolean;
  /** Tooltip + aria-label for the Expand button. */
  expandLabel?: string;
  /** Tooltip + aria-label for the Collapse button. */
  collapseLabel?: string;
}

export function ExpandCollapseButtons({
  onExpand,
  onCollapse,
  disabled = false,
  expandLabel = "Expand all folders",
  collapseLabel = "Collapse all folders",
}: ExpandCollapseButtonsProps) {
  return (
    <div className="flex items-center shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={expandLabel}
        title={expandLabel}
        disabled={disabled}
        className="shrink-0 rounded-r-none"
        onClick={onExpand}
      >
        <UnfoldVertical aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={collapseLabel}
        title={collapseLabel}
        disabled={disabled}
        className="shrink-0 rounded-l-none"
        onClick={onCollapse}
      >
        <FoldVertical aria-hidden="true" />
      </Button>
    </div>
  );
}
