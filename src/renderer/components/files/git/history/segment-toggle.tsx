/**
 * Segment toggle for the Source Control panel's Changes and History siblings.
 */
import type { GitPanelSegment } from "../../../../../shared/git/types";

interface HistorySegmentToggleProps {
  segment: GitPanelSegment;
  disabled?: boolean;
  onChange: (segment: GitPanelSegment) => void;
}

/** Renders the `[Changes][History]` segment control. */
export function HistorySegmentToggle({
  segment,
  disabled = false,
  onChange,
}: HistorySegmentToggleProps) {
  return (
    <div className="flex shrink-0 border-b border-mist-border px-2 py-1">
      <div
        role="tablist"
        aria-label="Source Control section"
        className="inline-flex rounded border border-mist-border bg-frosted-veil p-0.5"
      >
        <SegmentButton
          label="Changes"
          selected={segment === "changes"}
          disabled={disabled}
          onClick={() => onChange("changes")}
        />
        <SegmentButton
          label="History"
          selected={segment === "history"}
          disabled={disabled}
          onClick={() => onChange("history")}
        />
      </div>
    </div>
  );
}

/** Renders one tab-style segment button. */
function SegmentButton({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      disabled={disabled}
      className={
        selected
          ? "rounded-[3px] bg-frosted-veil-strong px-3 py-1 text-app-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          : "rounded-[3px] px-3 py-1 text-app-ui-sm text-muted-foreground hover:bg-frosted-veil-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}
