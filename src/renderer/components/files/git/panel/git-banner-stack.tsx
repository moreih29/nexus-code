/**
 * GitBannerStack — 1-slot + collapsed-counter banner area.
 *
 * Priority model (§1 axis-4 — High signals never hidden):
 *   High  push-guard · lastError
 *   Med   autofetch-paused
 *   Low   helper-prompt · context
 *
 * At most one banner is visible at a time (the highest-priority item).
 * Any remaining items are represented by a 24 px (h-6) counter row:
 *   "+2 notifications ›"
 * Clicking or pressing Enter/Space on the counter row expands all items
 * in-place (chevron rotates). Clicking again collapses back to 1 slot.
 *
 * unborn HEAD is no longer in the banner stack — it is shown as a
 * permanent caption in the branch identity area (GitBranchBar).
 *
 * Props accept the single `GitBannerModel` produced by buildGitBannerModel().
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../../utils/cn";
import type { GitBannerModel, BannerSlotItem } from "./git-banner-model";
import { GitInlineBanner } from "./git-inline-banner";
import type { PushGuardActionKind } from "../utils/git-push-guard-banner";

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface GitBannerStackProps {
  model: GitBannerModel;
}

// ---------------------------------------------------------------------------
// Internal helpers — render one BannerSlotItem as a GitInlineBanner.
// ---------------------------------------------------------------------------

function renderBannerItem(item: BannerSlotItem): React.ReactNode {
  switch (item.kind) {
    case "push-guard":
      return (
        <GitInlineBanner
          key="push-guard"
          variant={item.view.variant}
          message={item.view.message}
          details={item.view.details}
          actions={item.view.actions.map((action) => ({
            label: action.label,
            variant:
              action.destructive === true
                ? "destructive"
                : action.kind === "cancel"
                  ? "ghost"
                  : "default",
            onAction: () => (item.onAction as (k: PushGuardActionKind) => void)(action.kind),
          }))}
        />
      );

    case "error":
      return (
        <GitInlineBanner
          key="error"
          variant="error"
          message={item.message}
          details={item.details}
          actionLabel={item.actionLabel}
          onAction={item.onAction}
        />
      );

    case "autofetch-paused":
      return (
        <GitInlineBanner
          key="autofetch-paused"
          variant="warning"
          message="Autofetch paused after repeated failures."
          details={item.details}
          actionLabel="Resume"
          onAction={item.onResume}
        />
      );

    case "helper-prompt":
      return (
        <GitInlineBanner
          key="helper-prompt"
          variant="info"
          message={item.message}
        />
      );

    case "context":
      return (
        <GitInlineBanner
          key="context"
          variant={item.variant}
          message={item.message}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Counter row — 24 px collapsed notification indicator.
// ---------------------------------------------------------------------------

interface CounterRowProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

function CounterRow({ count, expanded, onToggle }: CounterRowProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-6 w-full shrink-0 items-center gap-1 border-b border-border bg-muted px-3",
        "text-app-ui-xs text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse notifications" : `${count} more notification${count === 1 ? "" : "s"}`}
      onClick={onToggle}
    >
      <span className="flex-1 text-left">
        {expanded ? "Collapse" : `+${count} notification${count === 1 ? "" : "s"}`}
      </span>
      <ChevronDown
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// GitBannerStack
// ---------------------------------------------------------------------------

export function GitBannerStack({ model }: GitBannerStackProps) {
  const [expanded, setExpanded] = useState(false);

  const { slotItem, collapsedItems, collapsedCount } = model;

  // Nothing to show.
  if (!slotItem) return null;

  const showCounter = collapsedCount > 0;

  return (
    <div className="flex flex-col">
      {/* Primary slot — always the highest-priority banner. */}
      {renderBannerItem(slotItem)}

      {/* Collapsed items — only shown when expanded. */}
      {expanded && collapsedItems.map((item) => renderBannerItem(item))}

      {/* Counter row — 24 px, shown only when there are collapsed items. */}
      {showCounter ? (
        <CounterRow
          count={collapsedCount}
          expanded={expanded}
          onToggle={() => setExpanded((prev) => !prev)}
        />
      ) : null}
    </div>
  );
}
