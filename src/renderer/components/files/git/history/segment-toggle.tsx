/**
 * Segment toggle for the Source Control panel's Changes and History siblings.
 */
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("files");
  return (
    <div className="flex shrink-0 border-b border-border px-2 py-1">
      <div
        role="tablist"
        aria-label={t("git.panel.segments.ariaLabel")}
        className="inline-flex rounded border border-border bg-muted p-0.5"
      >
        <SegmentButton
          label={t("git.panel.segments.changes")}
          selected={segment === "changes"}
          disabled={disabled}
          onClick={() => onChange("changes")}
        />
        <SegmentButton
          label={t("git.panel.segments.history")}
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
          ? "rounded-(--radius-control) bg-[var(--state-active-bg)] px-3 py-1 text-app-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          : "rounded-(--radius-control) px-3 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}
