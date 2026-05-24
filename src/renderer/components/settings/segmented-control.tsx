// src/renderer/components/settings/segmented-control.tsx — Segmented control.
//
// Design seal: radius-control (4px) per segment, radius-raised (6px) outer group.
// Selected segment: state.selected.bg + foreground text.
// Rest: transparent text-muted-foreground.
// No shadows.
//
// ARIA: wrapping div is role="group", each segment is a toggle button with
// aria-pressed. Avoids role="radio" on <button> (prohibited by ARIA in HTML).

import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /**
   * Optional leading visual — used by Cursor style to show ▮/_/| previews
   * alongside the label. Rendered inline before the label text.
   */
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible label for the group. */
  label: string;
  id?: string;
  /**
   * Disables every segment. The current `value` is still shown as
   * pressed, but onChange will not fire. `disabledReason` populates the
   * native `title` tooltip so the user sees why interaction is locked.
   */
  disabled?: boolean;
  disabledReason?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  id,
  disabled,
  disabledReason,
}: SegmentedControlProps<T>) {
  const groupId = id ?? `segmented-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <fieldset
      aria-label={label}
      id={groupId}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "inline-flex rounded-(--radius-raised) border border-border bg-muted p-0.5 gap-0.5",
        disabled && "opacity-60",
      )}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5",
              "rounded-(--radius-control) px-2 py-0.5 text-app-ui-sm font-sans transition-colors",
              isSelected
                ? "bg-[var(--state-selected-bg)] text-[var(--state-selected-fg)]"
                : "bg-transparent text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              disabled && "cursor-not-allowed",
            )}
          >
            {opt.icon && (
              <span className="inline-flex shrink-0 items-center" aria-hidden="true">
                {opt.icon}
              </span>
            )}
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}
